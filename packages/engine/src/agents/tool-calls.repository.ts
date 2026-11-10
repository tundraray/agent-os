import { randomUUID } from 'node:crypto';
import { type Database, researchAgentToolCalls, researchInvestigations } from '@agent-os/db';
import type { RuntimeTx, TaskContext } from '@agent-os/runtime';
import { and, asc, eq, sql } from 'drizzle-orm';
import { sessionRepository } from './session.repository.js';
import { type AuditOutcome, toolAuditRepository } from './tool-audit.repository.js';

/**
 * States of a tool call (design-agent-core.md, «Как исполняется вызов инструмента»): born `requested` with the turn's
 * answer; `read` and `write` go to `done` at once; a `task` call goes `starting` (share and task specification
 * recorded) → `waiting` (task proposed or found) → `done`; any refusal is `rejected`.
 */
export type ToolCallState = 'requested' | 'starting' | 'waiting' | 'done' | 'rejected';

export type ToolCallRow = typeof researchAgentToolCalls.$inferSelect;

/** One call the model asked for in a turn. */
export interface RequestedCall {
  /** The call's number within its run. */
  readonly callIndex: number;
  readonly toolName: string;
  readonly arguments: unknown;
}

/** The attempt functions a transition needs; the handler passes its `TaskContext`. */
export type CallContext = Pick<TaskContext, 'withAttemptGuard' | 'investigationId' | 'taskId' | 'signal'>;

/**
 * How a call ends. `done` carries its audit class and result; `rejected` its code and `rejected` — or `access_denied`
 * when `ToolAccessPolicy` refused it (FR-10).
 */
export type CallEnding =
  | {
      readonly to: 'done';
      readonly outcome: Exclude<AuditOutcome, 'rejected' | 'access_denied'>;
      readonly result: unknown;
      /** A remark that goes with a result, such as `child_failed` with its reason. */
      readonly reason?: string;
      readonly sourceId?: string | null;
      /** `call_agent`: the recounted spending of the child's subtree. */
      readonly spentTokens?: number;
    }
  | {
      readonly to: 'rejected';
      readonly outcome: 'rejected' | 'access_denied';
      readonly reason: string;
      /** What the model reads with the code, such as the limit that was met. */
      readonly detail?: unknown;
      readonly sourceId?: string | null;
    };

/** What the `outcome` of a call holds before it ends: its task answers a request made before (DC-11). */
export const REPEAT_MARK = { repeat: true } as const;

/** A step of a call; the transition table below says from which state each is allowed. */
export type CallStep =
  | {
      readonly to: 'starting';
      /** Null for a task tool, which takes no share and no `maxChildren` slot. */
      readonly shareTokens: number | null;
      readonly taskSpec: unknown;
      readonly outcome?: typeof REPEAT_MARK;
    }
  | { readonly to: 'waiting'; readonly childTaskId: string; readonly outcome?: typeof REPEAT_MARK }
  | CallEnding;

const ALLOWED: Readonly<Record<ToolCallState, readonly ToolCallState[]>> = {
  requested: ['starting', 'done', 'rejected'],
  starting: ['waiting', 'rejected'],
  waiting: ['done'],
  done: [],
  rejected: [],
};

/**
 * Result of a transition: `written` — the step and everything it carries committed together; `not_in_state` — the call
 * was not in one of the expected states (a retry of a step that already happened), nothing written; `fenced` and
 * `stopping` — the guard refused, `decide` did not run and nothing was written (ADR-0006: after a stop no call goes on).
 */
export type TransitionResult =
  | { readonly outcome: 'written'; readonly call: ToolCallRow }
  | { readonly outcome: 'not_in_state'; readonly call: ToolCallRow }
  | { readonly outcome: 'fenced' }
  | { readonly outcome: 'stopping' };

/** Decides the step inside the guarded transaction; a `write` tool's effect is written here, with its outcome. */
export type DecideStep = (tx: RuntimeTx, call: ToolCallRow) => Promise<CallStep>;

async function ownerOf(tx: RuntimeTx, investigationId: string): Promise<string> {
  const [row] = await tx
    .select({ resourceId: researchInvestigations.resourceId })
    .from(researchInvestigations)
    .where(eq(researchInvestigations.investigationId, investigationId));
  if (row === undefined) throw new Error(`investigation ${investigationId} is missing`);
  return row.resourceId;
}

/** Ends the call: its outcome, its result message in the session and exactly one audit row (KD-3, invariant 12). */
async function writeEnding(tx: RuntimeTx, call: ToolCallRow, ending: CallEnding): Promise<ToolCallRow> {
  const auditId = await toolAuditRepository.insert(tx, {
    resourceId: await ownerOf(tx, call.investigationId),
    toolName: call.toolName,
    sourceId: ending.sourceId ?? null,
    outcome: ending.outcome,
  });
  const body =
    ending.to === 'done'
      ? { outcome: ending.outcome, result: ending.result, ...(ending.reason === undefined ? {} : { reason: ending.reason }) }
      : { outcome: ending.outcome, reason: ending.reason, ...(ending.detail === undefined ? {} : { detail: ending.detail }) };
  const [ended] = await tx
    .update(researchAgentToolCalls)
    .set({
      state: ending.to,
      outcome: body,
      reason: ending.reason ?? null,
      // A `read` or `write` call starts and ends in this one write; a `task` call started at `starting`.
      startedAt: sql`coalesce(${researchAgentToolCalls.startedAt}, now())`,
      finishedAt: sql`now()`,
      auditId,
      ...(ending.to === 'done' && ending.spentTokens !== undefined ? { spentTokens: ending.spentTokens } : {}),
    })
    .where(eq(researchAgentToolCalls.id, call.id))
    .returning();
  await sessionRepository.append(tx, { runTaskId: call.runTaskId, investigationId: call.investigationId }, [
    {
      kind: 'tool_result',
      content: { callIndex: call.callIndex, toolName: call.toolName, ...body },
      toolCallId: call.id,
    },
  ]);
  return ended as ToolCallRow;
}

async function writeStep(tx: RuntimeTx, call: ToolCallRow, step: CallStep): Promise<ToolCallRow> {
  if (!ALLOWED[call.state as ToolCallState].includes(step.to)) {
    throw new Error(`tool call ${call.id} cannot go from ${call.state} to ${step.to}`);
  }
  if (step.to === 'done' || step.to === 'rejected') return writeEnding(tx, call, step);
  const mark = step.outcome === undefined ? {} : { outcome: step.outcome };
  const values =
    step.to === 'starting'
      ? { state: step.to, shareTokens: step.shareTokens, taskSpec: step.taskSpec, startedAt: sql`now()`, ...mark }
      : { state: step.to, childTaskId: step.childTaskId, ...mark };
  const [moved] = await tx
    .update(researchAgentToolCalls)
    .set(values)
    .where(eq(researchAgentToolCalls.id, call.id))
    .returning();
  return moved as ToolCallRow;
}

/** `research_agent_tool_calls`: one mutable row per call the model asked for (KD-2, KD-3). */
export const toolCallsRepository = {
  /** Writes the calls of a turn as `requested`, in the transaction that writes the turn's answer. */
  async insertRequested(
    tx: RuntimeTx,
    turn: { readonly investigationId: string; readonly runTaskId: string; readonly turn: number },
    calls: readonly RequestedCall[],
  ): Promise<ToolCallRow[]> {
    if (calls.length === 0) return [];
    return tx
      .insert(researchAgentToolCalls)
      .values(
        calls.map((call) => ({
          id: randomUUID(),
          investigationId: turn.investigationId,
          runTaskId: turn.runTaskId,
          turn: turn.turn,
          callIndex: call.callIndex,
          toolName: call.toolName,
          arguments: call.arguments,
          state: 'requested',
        })),
      )
      .returning();
  },

  /** The calls of a run, by number. */
  ofRun(db: Database | RuntimeTx, runTaskId: string): Promise<ToolCallRow[]> {
    return db
      .select()
      .from(researchAgentToolCalls)
      .where(eq(researchAgentToolCalls.runTaskId, runTaskId))
      .orderBy(asc(researchAgentToolCalls.callIndex));
  },

  /**
   * One step of a call of the attempt's own run, as one guarded write in the mode `requireActive` (KD-3): the call row
   * is locked, and only when it is in one of `from` does `decide` run and its step get written — an ending with the
   * call's audit row and result message, all in this transaction. A call already past `from` is left as it is, so a
   * repeated step writes nothing (invariant 3).
   */
  async transition(
    ctx: CallContext,
    request: { readonly callId: string; readonly from: readonly ToolCallState[] },
    decide: DecideStep,
  ): Promise<TransitionResult> {
    const guarded = await ctx.withAttemptGuard(
      async (tx): Promise<TransitionResult> => {
        const [call] = await tx
          .select()
          .from(researchAgentToolCalls)
          .where(and(eq(researchAgentToolCalls.id, request.callId), eq(researchAgentToolCalls.runTaskId, ctx.taskId)))
          .for('update');
        if (call === undefined) throw new Error(`tool call ${request.callId} is not a call of task ${ctx.taskId}`);
        if (!request.from.includes(call.state as ToolCallState)) return { outcome: 'not_in_state', call };
        return { outcome: 'written', call: await writeStep(tx, call, await decide(tx, call)) };
      },
      { requireActive: true },
    );
    return guarded.outcome === 'committed' ? guarded.value : guarded;
  },
};
