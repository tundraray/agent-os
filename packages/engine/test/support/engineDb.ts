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
  researchDecisions,
  researchEngineRuns,
  researchInvestigations,
  researchLlmCalls,
  researchLlmTranscripts,
  researchPlanRevisions,
  researchSignals,
  researchTasks,
} from '@agent-os/db';
import type { InvestigationService } from '@agent-os/runtime';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
    decisions: await db()
      .select()
      .from(researchDecisions)
      .where(eq(researchDecisions.investigationId, investigationId))
      .orderBy(asc(researchDecisions.step), asc(researchDecisions.callIndex)),
    signals: await db()
      .select()
      .from(researchSignals)
      .where(eq(researchSignals.investigationId, investigationId))
      .orderBy(asc(researchSignals.recordedAt), asc(researchSignals.signalId)),
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

/**
 * The row version (`xmin`) of every row of the investigation — its own row, its tasks and the engine rows — keyed by
 * `table:primary key`. Two equal snapshots mean no row was written in between ("no row changed" checks).
 */
export async function rowVersionsOf(investigationId: string): Promise<Map<string, string>> {
  const id = sql`${investigationId}::uuid`;
  const { rows } = await db().execute<{ key: string; version: string }>(sql`
    select 'research_investigations:' || investigation_id as key, xmin::text as version
      from ${researchInvestigations} where investigation_id = ${id}
    union all select 'research_tasks:' || task_id, xmin::text from ${researchTasks} where investigation_id = ${id}
    union all select 'research_engine_runs:' || investigation_id, xmin::text
      from ${researchEngineRuns} where investigation_id = ${id}
    union all select 'research_plan_revisions:' || revision, xmin::text
      from ${researchPlanRevisions} where investigation_id = ${id}
    union all select 'research_decisions:' || decision_id, xmin::text from ${researchDecisions} where investigation_id = ${id}
    union all select 'research_signals:' || signal_id, xmin::text from ${researchSignals} where investigation_id = ${id}
    union all select 'research_claims:' || claim_revision_id, xmin::text
      from ${researchClaims} where investigation_id = ${id}
    union all select 'research_llm_calls:' || call_id, xmin::text from ${researchLlmCalls} where investigation_id = ${id}
  `);
  return new Map(rows.map((row) => [row.key, row.version]));
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
  for (const { investigationId, resourceId } of leftovers) {
    await investigations.cancel(investigationId, resourceId);
  }
}
