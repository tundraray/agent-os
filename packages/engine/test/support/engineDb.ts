import {
  agentToolAudit,
  createDatabase,
  type Database,
  type DatabaseConnection,
  researchAgentMemory,
  researchAgentMessages,
  researchAgentRuns,
  researchAgentToolCalls,
  researchClaims,
  researchEngineRuns,
  researchEvidence,
  researchInvestigations,
  researchLlmCalls,
  researchLlmTranscripts,
  researchPlanRevisions,
  researchTasks,
} from '@agent-os/db';
import type { InvestigationService } from '@agent-os/runtime';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertTestDatabase, databaseUrl } from './database-url.js';

/**
 * Read-only snapshots of the engine's `research_*` rows for the integration file, over the test's own connections,
 * apart from the runtime's pool. Nothing here writes, apart from {@link cancelLeftovers}, which writes only through the
 * real `InvestigationService.cancel`.
 */

let connection: DatabaseConnection | undefined;

function db() {
  connection ??= createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
  return connection.db;
}

/** Closes the test's connections; call in `afterAll`. */
export async function closeEngineDb(): Promise<void> {
  await connection?.close();
  connection = undefined;
}

/** Engine rows of the user, oldest first: "one engine row per launch" checks. */
export function engineRunsOf(resourceId: string) {
  return db()
    .select()
    .from(researchEngineRuns)
    .where(eq(researchEngineRuns.resourceId, resourceId))
    .orderBy(asc(researchEngineRuns.createdAt), asc(researchEngineRuns.investigationId));
}

/** Every engine row of the investigation, table by table. */
export async function engineRowsOf(investigationId: string) {
  const [run] = await db()
    .select()
    .from(researchEngineRuns)
    .where(eq(researchEngineRuns.investigationId, investigationId));
  return {
    run,
    planRevisions: await db()
      .select()
      .from(researchPlanRevisions)
      .where(eq(researchPlanRevisions.investigationId, investigationId))
      .orderBy(asc(researchPlanRevisions.revision)),
    claims: await db()
      .select()
      .from(researchClaims)
      .where(eq(researchClaims.investigationId, investigationId))
      .orderBy(asc(researchClaims.createdAt), asc(researchClaims.claimRevisionId)),
    llmCalls: await db()
      .select()
      .from(researchLlmCalls)
      .where(eq(researchLlmCalls.investigationId, investigationId))
      .orderBy(asc(researchLlmCalls.createdAt), asc(researchLlmCalls.callId)),
  };
}

/**
 * The `research_llm_transcripts` rows of the investigation as stored, in the order of its `research_llm_calls` rows
 * above: a transcript is written in the same guarded transaction as its ledger row (design-self-check.md, KD-1).
 */
export function llmTranscriptsOf(investigationId: string) {
  return db()
    .select()
    .from(researchLlmTranscripts)
    .where(eq(researchLlmTranscripts.investigationId, investigationId))
    .orderBy(asc(researchLlmTranscripts.createdAt), asc(researchLlmTranscripts.callId));
}

/**
 * The rows of the investigation's agent tree, table by table (design-agent-core.md, Data Model): runs, session messages,
 * tool calls, the audit rows those calls reference (an audit row no call references: {@link auditOf}) and the investigation's
 * memory notes. Runs and calls in creation order, messages by run and number, notes by number.
 */
export async function agentRowsOf(investigationId: string) {
  const toolCalls = await db()
    .select()
    .from(researchAgentToolCalls)
    .where(eq(researchAgentToolCalls.investigationId, investigationId))
    .orderBy(asc(researchAgentToolCalls.createdAt), asc(researchAgentToolCalls.callIndex));
  const auditIds = toolCalls.flatMap((call) => (call.auditId === null ? [] : [call.auditId]));
  return {
    runs: await db()
      .select()
      .from(researchAgentRuns)
      .where(eq(researchAgentRuns.investigationId, investigationId))
      .orderBy(asc(researchAgentRuns.createdAt), asc(researchAgentRuns.taskId)),
    messages: await db()
      .select()
      .from(researchAgentMessages)
      .where(eq(researchAgentMessages.investigationId, investigationId))
      .orderBy(asc(researchAgentMessages.runTaskId), asc(researchAgentMessages.seq)),
    toolCalls,
    audit:
      auditIds.length === 0
        ? []
        : await db().select().from(agentToolAudit).where(inArray(agentToolAudit.id, auditIds)).orderBy(asc(agentToolAudit.recordedAt)),
    memory: await db()
      .select()
      .from(researchAgentMemory)
      .where(eq(researchAgentMemory.investigationId, investigationId))
      .orderBy(asc(researchAgentMemory.seq)),
  };
}

/**
 * Every audit row of an owner, oldest first. The audit table holds no investigation or run (AC-10.2), so a test that
 * counts audit rows per call reads them by its own unique user: an audit row no call references shows only here.
 */
export function auditOf(resourceId: string) {
  return db().select().from(agentToolAudit).where(eq(agentToolAudit.resourceId, resourceId)).orderBy(asc(agentToolAudit.recordedAt));
}

/** The session messages of one run, by number. */
export function sessionOf(runTaskId: string) {
  return db()
    .select()
    .from(researchAgentMessages)
    .where(eq(researchAgentMessages.runTaskId, runTaskId))
    .orderBy(asc(researchAgentMessages.seq));
}

/** The ledger rows of the investigation's agent turns (role `agent`), oldest first. */
export function llmCallsOf(investigationId: string) {
  return db()
    .select()
    .from(researchLlmCalls)
    .where(and(eq(researchLlmCalls.investigationId, investigationId), eq(researchLlmCalls.role, 'agent')))
    .orderBy(asc(researchLlmCalls.createdAt), asc(researchLlmCalls.callId));
}

/** Tasks of the investigation as the runtime stored them, oldest first. */
export function tasksOf(investigationId: string) {
  return db()
    .select()
    .from(researchTasks)
    .where(eq(researchTasks.investigationId, investigationId))
    .orderBy(asc(researchTasks.createdAt), asc(researchTasks.taskId));
}

/** The tool calls of the investigation with their run's agent and parent, in the order the calls were recorded. */
export function agentToolCallsOf(investigationId: string) {
  return db()
    .select({
      runTaskId: researchAgentToolCalls.runTaskId,
      agent: researchAgentRuns.agentName,
      parentTaskId: researchAgentRuns.parentTaskId,
      turn: researchAgentToolCalls.turn,
      callIndex: researchAgentToolCalls.callIndex,
      tool: researchAgentToolCalls.toolName,
      arguments: researchAgentToolCalls.arguments,
      state: researchAgentToolCalls.state,
      outcome: researchAgentToolCalls.outcome,
      reason: researchAgentToolCalls.reason,
      childTaskId: researchAgentToolCalls.childTaskId,
    })
    .from(researchAgentToolCalls)
    .innerJoin(researchAgentRuns, eq(researchAgentRuns.taskId, researchAgentToolCalls.runTaskId))
    .where(eq(researchAgentToolCalls.investigationId, investigationId))
    .orderBy(asc(researchAgentToolCalls.createdAt), asc(researchAgentToolCalls.callIndex));
}

/** Every revision of the investigation's claims in write order, with the run that wrote it (null for a task that is no run). */
export function claimRevisionsOf(investigationId: string) {
  return db()
    .select({
      seq: researchClaims.seq,
      claimId: researchClaims.claimId,
      claimIndex: researchClaims.claimIndex,
      text: researchClaims.text,
      status: researchClaims.status,
      confidence: researchClaims.confidence,
      claimType: researchClaims.claimType,
      assessment: researchClaims.assessment,
      evidenceIds: researchClaims.evidenceIds,
      pointer: researchClaims.pointer,
      authorTaskId: researchClaims.taskId,
      authorAgent: researchAgentRuns.agentName,
    })
    .from(researchClaims)
    .leftJoin(researchAgentRuns, eq(researchAgentRuns.taskId, researchClaims.taskId))
    .where(eq(researchClaims.investigationId, investigationId))
    .orderBy(asc(researchClaims.seq));
}

const GatherResultSchema = z.object({
  page: z.string(),
  returned: z.number(),
  repeat: z.literal(true).optional(),
});

/**
 * The pages of the investigation: `stored`, the evidence rows the source's fetch wrote, and `gathered`, each `gather` call
 * that returned a page, with its `repeat` mark.
 */
export async function gatherPagesOf(investigationId: string) {
  const stored = await db()
    .select({ pageId: researchEvidence.evidenceId, taskId: researchEvidence.taskId, provenance: researchEvidence.provenance, coverage: researchEvidence.coverage })
    .from(researchEvidence)
    .where(eq(researchEvidence.investigationId, investigationId))
    .orderBy(asc(researchEvidence.createdAt), asc(researchEvidence.evidenceId));
  const gathered = (await agentToolCallsOf(investigationId))
    .filter((call) => call.tool === 'gather')
    .flatMap((call) => {
      const page = GatherResultSchema.safeParse((call.outcome as { result?: unknown } | null)?.result);
      if (!page.success) return [];
      return [{ runTaskId: call.runTaskId, agent: call.agent, callIndex: call.callIndex, page: page.data.page, returned: page.data.returned, repeat: page.data.repeat === true }];
    });
  return { stored, gathered };
}

/**
 * The engine row with the answer and the root run's result, each with its row version: one `xmin` on both proves the answer
 * and the result were written by one transaction (KD-3). Undefined before the root's task is recorded.
 */
export async function answerRowOf(investigationId: string) {
  const [row] = await db()
    .select({
      engineRun: researchEngineRuns,
      engineVersion: sql<string>`${researchEngineRuns}.xmin::text`,
      rootResult: researchAgentRuns.result,
      rootVersion: sql<string>`${researchAgentRuns}.xmin::text`,
    })
    .from(researchEngineRuns)
    .innerJoin(researchAgentRuns, eq(researchAgentRuns.taskId, researchEngineRuns.controllerTaskId))
    .where(eq(researchEngineRuns.investigationId, investigationId));
  return row;
}

/** The owners a file's investigations were started for; each test file has its own instance of this module. */
const investigationOwners = new Set<string>();

/** Registers the owner of an investigation for {@link assertNoActiveInvestigations}. */
export function trackInvestigationOwner(resourceId: string): void {
  investigationOwners.add(resourceId);
}

/** How many owners the file registered: a file whose check must bite asserts this is not zero, the check alone passes on none. */
export function trackedOwnerCount(): number {
  return investigationOwners.size;
}

/** Investigations of the file's owners that a cleanup found still `active`: what the cleanup would otherwise hide from the check. */
const leftBehind: string[] = [];

/**
 * Cancels through the real service, noting first an investigation of the file's owners that is still `active`. A test that
 * stops one on purpose has cancelled it already, so only what a test left running is noted.
 */
export async function cancelNotingLeftBehind(
  database: Database,
  investigations: Pick<InvestigationService, 'cancel'>,
  { investigationId, resourceId }: { readonly investigationId: string; readonly resourceId: string },
): Promise<void> {
  if (investigationOwners.has(resourceId)) {
    const [row] = await database
      .select({ status: researchInvestigations.status })
      .from(researchInvestigations)
      .where(eq(researchInvestigations.investigationId, investigationId));
    if (row?.status === 'active') leftBehind.push(investigationId);
  }
  await investigations.cancel(investigationId, resourceId);
}

/**
 * Fails naming every investigation of the file's owners that a cleanup found `active` or that still is: a suite must not
 * leave work to the next one.
 */
export async function assertNoActiveInvestigations(): Promise<void> {
  if (leftBehind.length > 0) {
    throw new Error(`the suite left active investigations for its cleanup: ${leftBehind.join(', ')}`);
  }
  if (investigationOwners.size === 0) return;
  const left = await db()
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(and(inArray(researchInvestigations.resourceId, [...investigationOwners]), eq(researchInvestigations.status, 'active')));
  if (left.length > 0) {
    throw new Error(`the suite left active investigations: ${left.map((row) => row.investigationId).join(', ')}`);
  }
}

/**
 * The fence of an assembly or a run: every active investigation with an engine row — what an earlier run left, for
 * instance after a failed test — is cancelled through the real `InvestigationService.cancel`, so new workers never claim
 * a foreign controller task that would consume a script or a crash pass. Refuses a database that is not the local test one.
 */
export async function cancelLeftovers(database: Database, investigations: Pick<InvestigationService, 'cancel'>): Promise<void> {
  assertTestDatabase(databaseUrl());
  const leftovers = await database
    .select({ investigationId: researchInvestigations.investigationId, resourceId: researchInvestigations.resourceId })
    .from(researchInvestigations)
    .innerJoin(researchEngineRuns, eq(researchEngineRuns.investigationId, researchInvestigations.investigationId))
    .where(eq(researchInvestigations.status, 'active'));
  for (const leftover of leftovers) {
    await cancelNotingLeftBehind(database, investigations, leftover);
  }
}
