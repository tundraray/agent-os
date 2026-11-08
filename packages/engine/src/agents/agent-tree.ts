import {
  type Database,
  researchAgentMessages,
  researchAgentRuns,
  researchAgentToolCalls,
  researchEngineRuns,
  researchLlmCalls,
  researchLlmTranscripts,
  researchTasks,
} from '@agent-os/db';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { LEDGER_SPENT_TOKENS } from '../model/ledger.js';
import { treeBudgetExhausted } from './collect-reader.js';
import type { DefinitionMemorySnapshot } from './definition-memory.js';
import { SnapshotSchema } from './fingerprint.js';

/**
 * `Engine.readAgentTree` (design-agent-core.md, «Операции движка», DC-11, DC-16, FR-09): the runs of an investigation's
 * agent tree as its owner reads them — each with its parent and call, its assignment and the prologue's first message,
 * its task status, its result or failure, its own spending and its subtree's by the ledger, its turns with their ledger
 * rows and transcripts, and its tool calls with their outcomes — with the definition memory snapshot of the start and
 * `budgetExhausted`. Another owner's or an unknown investigation is `investigation_not_found`.
 */

export interface AgentTreeTurn {
  readonly turn: number;
  /** The ledger row of the turn's model call. */
  readonly llmCallId: string;
  /** The transcript of the call; null once the purge removed it. */
  readonly transcriptCallId: string | null;
}

export interface AgentTreeCall {
  readonly callIndex: number;
  readonly turn: number;
  readonly toolName: string;
  readonly state: string;
  /** The outcome and result or reason as the call stored them; null until the call has one. */
  readonly outcome: unknown;
  readonly reason: string | null;
  /** `call_agent`: the child run's task. */
  readonly childTaskId: string | null;
}

export interface AgentTreeRun {
  readonly runTaskId: string;
  readonly agentName: string;
  readonly parent: { readonly taskId: string; readonly callIndex: number } | null;
  readonly depth: number;
  /** Null for a form with a prologue, whose session has no assignment. */
  readonly assignment: string | null;
  /** The prologue's first message; null for a form without a prologue or before it ran. */
  readonly prologueFirstMessage: string | null;
  /** The status of the run's task. */
  readonly status: string;
  readonly result: unknown;
  readonly failure: unknown;
  readonly shareTokens: number;
  /** Charged tokens of the run's own calls, open reservations whole. */
  readonly spentTokens: number;
  /** The run's and its descendants' spending. */
  readonly subtreeSpentTokens: number;
  readonly turns: readonly AgentTreeTurn[];
  readonly toolCalls: readonly AgentTreeCall[];
}

export interface AgentTree {
  readonly investigationId: string;
  /** Root first, then by creation. */
  readonly runs: readonly AgentTreeRun[];
  /** The definition memory the investigation ran with, by agent name (AC-22.4); empty for a start without one. */
  readonly definitionMemorySnapshot: DefinitionMemorySnapshot;
  readonly budgetExhausted: boolean;
}

export type ReadAgentTreeResult =
  | { readonly outcome: 'found'; readonly tree: AgentTree }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' };

const NOT_FOUND: ReadAgentTreeResult = { outcome: 'rejected', code: 'investigation_not_found' };

const TurnContentSchema = z.object({ turn: z.number().int() });
const TextContentSchema = z.object({ text: z.string() });

/** Spending of each task by the ledger: charged rows, open reservations whole. */
async function spendingByTask(db: Database, investigationId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      taskId: researchLlmCalls.taskId,
      spent: LEDGER_SPENT_TOKENS,
    })
    .from(researchLlmCalls)
    .where(eq(researchLlmCalls.investigationId, investigationId))
    .groupBy(researchLlmCalls.taskId);
  return new Map(rows.map((row) => [row.taskId, row.spent]));
}

/** The turns of each run: its model answers with their ledger rows, and whether the transcript is still kept. */
async function turnsByRun(db: Database, investigationId: string): Promise<Map<string, AgentTreeTurn[]>> {
  const rows = await db
    .select({
      runTaskId: researchAgentMessages.runTaskId,
      content: researchAgentMessages.content,
      llmCallId: researchAgentMessages.llmCallId,
      transcriptCallId: researchLlmTranscripts.callId,
    })
    .from(researchAgentMessages)
    .leftJoin(researchLlmTranscripts, eq(researchLlmTranscripts.callId, researchAgentMessages.llmCallId))
    .where(and(eq(researchAgentMessages.investigationId, investigationId), eq(researchAgentMessages.kind, 'model_answer')))
    .orderBy(asc(researchAgentMessages.runTaskId), asc(researchAgentMessages.seq));
  const turns = new Map<string, AgentTreeTurn[]>();
  for (const row of rows) {
    if (row.llmCallId === null) continue;
    const list = turns.get(row.runTaskId) ?? [];
    list.push({ turn: TurnContentSchema.parse(row.content).turn, llmCallId: row.llmCallId, transcriptCallId: row.transcriptCallId });
    turns.set(row.runTaskId, list);
  }
  return turns;
}

/** The first message of each run whose form has a prologue. */
async function prologuesByRun(db: Database, investigationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ runTaskId: researchAgentMessages.runTaskId, content: researchAgentMessages.content })
    .from(researchAgentMessages)
    .where(and(eq(researchAgentMessages.investigationId, investigationId), eq(researchAgentMessages.kind, 'prologue')));
  return new Map(rows.map((row) => [row.runTaskId, TextContentSchema.parse(row.content).text]));
}

async function callsByRun(db: Database, investigationId: string): Promise<Map<string, AgentTreeCall[]>> {
  const rows = await db
    .select()
    .from(researchAgentToolCalls)
    .where(eq(researchAgentToolCalls.investigationId, investigationId))
    .orderBy(asc(researchAgentToolCalls.runTaskId), asc(researchAgentToolCalls.callIndex));
  const calls = new Map<string, AgentTreeCall[]>();
  for (const row of rows) {
    const list = calls.get(row.runTaskId) ?? [];
    list.push({
      callIndex: row.callIndex,
      turn: row.turn,
      toolName: row.toolName,
      state: row.state,
      outcome: row.outcome,
      reason: row.reason,
      childTaskId: row.childTaskId,
    });
    calls.set(row.runTaskId, list);
  }
  return calls;
}

export async function readAgentTree(
  db: Database,
  input: { readonly investigationId: string; readonly resourceId: string },
): Promise<ReadAgentTreeResult> {
  const { investigationId } = input;
  if (!z.uuid().safeParse(investigationId).success) return NOT_FOUND;
  const [engineRun] = await db
    .select({ snapshot: researchEngineRuns.definitionMemorySnapshot })
    .from(researchEngineRuns)
    .where(and(eq(researchEngineRuns.investigationId, investigationId), eq(researchEngineRuns.resourceId, input.resourceId)));
  if (engineRun === undefined) return NOT_FOUND;

  const runRows = await db
    .select({ run: researchAgentRuns, status: researchTasks.status })
    .from(researchAgentRuns)
    .innerJoin(researchTasks, eq(researchTasks.taskId, researchAgentRuns.taskId))
    .where(eq(researchAgentRuns.investigationId, investigationId))
    .orderBy(asc(researchAgentRuns.depth), asc(researchAgentRuns.createdAt), asc(researchAgentRuns.taskId));
  const [spending, turns, prologues, calls, budgetExhausted] = await Promise.all([
    spendingByTask(db, investigationId),
    turnsByRun(db, investigationId),
    prologuesByRun(db, investigationId),
    callsByRun(db, investigationId),
    treeBudgetExhausted(db, investigationId),
  ]);
  const children = new Map<string, string[]>();
  for (const { run } of runRows) {
    if (run.parentTaskId === null) continue;
    children.set(run.parentTaskId, [...(children.get(run.parentTaskId) ?? []), run.taskId]);
  }
  const subtreeOf = (taskId: string): number =>
    (spending.get(taskId) ?? 0) + (children.get(taskId) ?? []).reduce((sum, child) => sum + subtreeOf(child), 0);

  const runs: AgentTreeRun[] = runRows.map(({ run, status }) => ({
    runTaskId: run.taskId,
    agentName: run.agentName,
    parent: run.parentTaskId === null ? null : { taskId: run.parentTaskId, callIndex: run.parentCallIndex ?? 0 },
    depth: run.depth,
    assignment: run.assignment,
    prologueFirstMessage: prologues.get(run.taskId) ?? null,
    status,
    result: run.result,
    failure: run.failure,
    shareTokens: run.shareTokens,
    spentTokens: spending.get(run.taskId) ?? 0,
    subtreeSpentTokens: subtreeOf(run.taskId),
    turns: turns.get(run.taskId) ?? [],
    toolCalls: calls.get(run.taskId) ?? [],
  }));
  return {
    outcome: 'found',
    tree: {
      investigationId,
      runs,
      definitionMemorySnapshot: SnapshotSchema.parse(engineRun.snapshot ?? {}),
      budgetExhausted,
    },
  };
}
