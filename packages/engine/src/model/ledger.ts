import { randomUUID } from 'node:crypto';
import { researchAgentToolCalls, researchEngineRuns, researchLlmCalls, researchTasks } from '@agent-os/db';
import type { RuntimeTx, TaskContext } from '@agent-os/runtime';
import { and, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import {
  closeTranscript,
  insertOpenTranscript,
  type TranscriptClosing,
  type TranscriptOpening,
} from '../transcripts/transcript-writes.js';
import { type ChildHolding, occupiedTokens } from '../agents/share-rule.js';
import type { CallUsage } from './cost.js';
import { decideReserve } from './reserve-rule.js';

/** The role of a ledger row: `agent` for every turn of an agent run (design-agent-core.md, Роль `agent`). */
export type ModelRole = 'agent';

/** A reservation to record before the call (KD-4): counted input + margin + output cap. */
export interface ReservationRequest {
  readonly role: ModelRole;
  readonly model: string;
  readonly countedInputTokens: number;
  readonly reservedTokens: number;
  /** The transcript the reservation opens in the same guarded write (design-self-check.md, KD-1). */
  readonly transcript: TranscriptOpening;
}

/**
 * How a reservation ended, checked in this order: `fenced` — the attempt is not the task's current one; `stopping` —
 * the task has a cancel request or its investigation is closed or stopped (design-lifecycle.md, KD-2); then the
 * budget by `decideReserve`: `refused`, or `busy` — only the open reserves of other calls keep it out, and the caller
 * may ask again (DC-5). Only `reserved` writes a ledger row, a transcript or a counter.
 */
export type ReservationOutcome =
  | { readonly outcome: 'reserved'; readonly callId: string }
  | {
      readonly outcome: 'refused';
      readonly code: 'task_tokens_exhausted' | 'investigation_tokens_exhausted';
    }
  | { readonly outcome: 'busy' }
  | { readonly outcome: 'fenced' }
  | { readonly outcome: 'stopping' };

/** How a reservation closes: `settled` by the answer's usage, `failed` by what a provider error reported. */
export interface ReservationClosing {
  readonly callId: string;
  readonly status: 'settled' | 'failed';
  /** Null when the provider reported no usage. */
  readonly usage: CallUsage | null;
  readonly chargedTokens: number;
  readonly costUsd: number;
  /** How the call's transcript closes in the same guarded write; usage and cost are taken from this closing. */
  readonly transcript: TranscriptClosing;
  /**
   * Writes the answer in the same guarded transaction that closes the row (an agent turn's answer into its session), so
   * the answer and its ledger row are written together; absent for role calls, which checkpoint before the close.
   */
  readonly writeAnswer?: (tx: RuntimeTx) => Promise<void>;
}

/**
 * How a close ended. `already_abandoned` — a DC-9 close point charged the whole reservation before the call came back:
 * the late close changes nothing, so the ledger never understates the spend, and its transcript stays without an
 * answer, read as `abandoned` (design-self-check.md, Transcript).
 */
export type ClosingOutcome = 'closed' | 'fenced' | 'already_abandoned';

/** The call ledger port of `ModelGateway`; every write goes through `withAttemptGuard`. */
export interface CallLedger {
  reserve(ctx: TaskContext, request: ReservationRequest): Promise<ReservationOutcome>;
  close(ctx: TaskContext, closing: ReservationClosing): Promise<ClosingOutcome>;
}

const COST_SCALE = 8;

/**
 * Locks the investigation's engine row. The guard has locked the task row before `work` runs,
 * so every ledger write takes the locks task row → engine row: workers of one investigation
 * never deadlock, and their reservations serialize on the engine row.
 */
async function lockEngineRun(tx: RuntimeTx, investigationId: string) {
  const [run] = await tx
    .select({
      tokenBudget: researchEngineRuns.tokenBudget,
      tokensReserved: researchEngineRuns.tokensReserved,
      tokensSpent: researchEngineRuns.tokensSpent,
    })
    .from(researchEngineRuns)
    .where(eq(researchEngineRuns.investigationId, investigationId))
    .for('update');
  if (run === undefined) {
    throw new Error(`engine row of investigation ${investigationId} is missing`);
  }
  return run;
}

/**
 * The spend of a set of ledger rows, as an aggregate: open reservations whole, closed rows as charged (KD-4). The ledger
 * may overstate the spend, never understate it.
 */
export const LEDGER_SPENT_TOKENS = sql<number>`coalesce(sum(case when ${researchLlmCalls.status} = 'reserved' then ${researchLlmCalls.reservedTokens} else ${researchLlmCalls.chargedTokens} end), 0)::int`;

/** Tokens the task holds across all its attempts: open reservations whole, closed rows as charged. */
async function taskTokensHeld(tx: RuntimeTx, taskId: string): Promise<number> {
  const [row] = await tx
    .select({ held: LEDGER_SPENT_TOKENS })
    .from(researchLlmCalls)
    .where(eq(researchLlmCalls.taskId, taskId));
  return row?.held ?? 0;
}

/**
 * The child shares a run holds (KD-4): calls with a share that are not refused, with their subtree's state and spending.
 * A descendant's call in `starting` may have its task proposed before its id is written (the run was lost in between):
 * that task is found by its input's parent — the run and the call's number — so it counts as working and its spending
 * as the subtree's (DC-9, invariant 6).
 */
async function childHoldings(tx: RuntimeTx, runTaskId: string): Promise<(ChildHolding & { readonly callId: string })[]> {
  const calls = researchAgentToolCalls;
  const { rows } = await tx.execute<{ call_id: string; share_tokens: number; in_work: boolean; spent: number }>(sql`
    with recursive subtree(call_id, task_id) as (
      select ${calls.id}, ${calls.childTaskId} from ${calls}
       where ${calls.runTaskId} = ${runTaskId} and ${calls.shareTokens} is not null
         and ${calls.state} <> 'rejected' and ${calls.childTaskId} is not null
      union
      select subtree.call_id, coalesce(descendant.child_task_id, proposed.task_id)
        from subtree join ${calls} as descendant on descendant.run_task_id = subtree.task_id
        left join lateral (
          select task.task_id from ${researchTasks} as task
           where descendant.child_task_id is null and descendant.state = 'starting'
             and task.investigation_id = descendant.investigation_id
             and task.input->'parent'->>'taskId' = descendant.run_task_id::text
             and task.input->'parent'->>'callIndex' = descendant.call_index::text
        ) as proposed on true
       where coalesce(descendant.child_task_id, proposed.task_id) is not null
    )
    select parent.id as call_id,
           parent.share_tokens,
           parent.child_task_id is null or exists (
             select 1 from subtree join ${researchTasks} as task on task.task_id = subtree.task_id
              where subtree.call_id = parent.id and task.status not in ('succeeded', 'failed', 'cancelled')
           ) as in_work,
           -- the aggregate of LEDGER_SPENT_TOKENS, spelled out: this raw query reads the ledger by an alias
           coalesce((
             select sum(case when ledger.status = 'reserved' then ledger.reserved_tokens else ledger.charged_tokens end)
               from ${researchLlmCalls} as ledger
              where ledger.task_id in (select subtree.task_id from subtree where subtree.call_id = parent.id)
           ), 0)::int as spent
      from ${calls} as parent
     where parent.run_task_id = ${runTaskId} and parent.share_tokens is not null and parent.state <> 'rejected'
  `);
  return rows.map((row) => ({
    callId: row.call_id,
    shareTokens: row.share_tokens,
    subtreeInWork: row.in_work,
    subtreeSpentTokens: row.spent,
  }));
}

/**
 * The spend of the subtree a `call_agent` call started, by the same ledger walk as the share (KD-4): what the call's
 * `spent_tokens` records when it ends `waiting` → `done`. 0 for a call without a share.
 */
export async function callSubtreeSpentTokens(tx: RuntimeTx, call: { readonly runTaskId: string; readonly id: string }): Promise<number> {
  const holding = (await childHoldings(tx, call.runTaskId)).find((held) => held.callId === call.id);
  return holding?.subtreeSpentTokens ?? 0;
}

/**
 * What an agent run occupies of its share (KD-4, invariant 6): its own spending across its attempts plus, per child, the
 * whole share while the child's subtree works and the subtree's spending once it does not. A turn's reservation and a
 * child's share are checked against the share minus this.
 */
export async function runOccupiedTokens(tx: RuntimeTx, runTaskId: string): Promise<number> {
  return occupiedTokens({ ownTokens: await taskTokensHeld(tx, runTaskId), children: await childHoldings(tx, runTaskId) });
}

/**
 * Open reservations no attempt will close any more (DC-9): those of a task's earlier attempts, those of tasks in a final
 * status, or every one of the investigation when its answer is written.
 */
export type AbandonedReservations =
  | { readonly taskId: string; readonly beforeAttempt: number }
  | { readonly taskIds: readonly string[] }
  | { readonly all: true };

function abandonedFilter(reservations: AbandonedReservations): SQL | undefined {
  if ('beforeAttempt' in reservations) {
    return and(eq(researchLlmCalls.taskId, reservations.taskId), lt(researchLlmCalls.attempt, reservations.beforeAttempt));
  }
  if ('taskIds' in reservations) return inArray(researchLlmCalls.taskId, [...reservations.taskIds]);
  return undefined;
}

/**
 * Closes open reservations of the investigation as `abandoned`, each charged in full: the ledger may overstate the
 * spend, never understate it (KD-4). Runs inside the caller's guarded transaction, after the guard's lock of the task
 * row; returns how many it closed.
 */
export async function abandonReservations(
  tx: RuntimeTx,
  investigationId: string,
  reservations: AbandonedReservations,
): Promise<number> {
  if ('taskIds' in reservations && reservations.taskIds.length === 0) return 0;
  await lockEngineRun(tx, investigationId);
  const closed = await tx
    .update(researchLlmCalls)
    .set({ status: 'abandoned', chargedTokens: researchLlmCalls.reservedTokens, costUsd: (0).toFixed(COST_SCALE), closedAt: sql`now()` })
    .where(
      and(
        eq(researchLlmCalls.investigationId, investigationId),
        eq(researchLlmCalls.status, 'reserved'),
        abandonedFilter(reservations),
      ),
    )
    .returning({ reservedTokens: researchLlmCalls.reservedTokens });
  if (closed.length === 0) return 0;
  const tokens = closed.reduce((sum, row) => sum + row.reservedTokens, 0);
  await tx
    .update(researchEngineRuns)
    .set({
      tokensReserved: sql`${researchEngineRuns.tokensReserved} - ${tokens}`,
      tokensSpent: sql`${researchEngineRuns.tokensSpent} + ${tokens}`,
    })
    .where(eq(researchEngineRuns.investigationId, investigationId));
  return closed.length;
}

/**
 * DC-9 at the start of a later attempt: what the task's earlier attempts reserved and never closed — a lost lease, a
 * killed process, a shutdown mid-call — is closed `abandoned` under this attempt's guard.
 */
export async function abandonEarlierAttempts(ctx: TaskContext): Promise<'closed' | 'fenced'> {
  if (ctx.attempt <= 1) return 'closed';
  const guarded = await ctx.withAttemptGuard((tx) =>
    abandonReservations(tx, ctx.investigationId, { taskId: ctx.taskId, beforeAttempt: ctx.attempt }),
  );
  return guarded.outcome === 'fenced' ? 'fenced' : 'closed';
}

/** The Postgres ledger: rows of `research_llm_calls` and the counters of `research_engine_runs`. */
export const postgresCallLedger: CallLedger = {
  /** In the guard's mode `requireActive`: no new call starts in stopped or closed work, on any instance. */
  async reserve(ctx, request) {
    const guarded = await ctx.withAttemptGuard(
      async (tx): Promise<ReservationOutcome> => {
        const run = await lockEngineRun(tx, ctx.investigationId);
        // An agent run holds its children's shares besides its own calls (KD-4).
        const held = await runOccupiedTokens(tx, ctx.taskId);
        const decided = decideReserve({
          ...run,
          taskTokensHeld: held,
          taskMaxTokens: ctx.budget.maxTokens,
          reservedTokens: request.reservedTokens,
        });
        if (decided.decision === 'refused') return { outcome: 'refused', code: decided.code };
        if (decided.decision === 'busy') return { outcome: 'busy' };
        const callId = randomUUID();
        await tx.insert(researchLlmCalls).values({
          callId,
          investigationId: ctx.investigationId,
          taskId: ctx.taskId,
          attempt: ctx.attempt,
          role: request.role,
          model: request.model,
          reservedTokens: request.reservedTokens,
          countedInputTokens: request.countedInputTokens,
        });
        await insertOpenTranscript(tx, ctx, {
          callId,
          role: request.role,
          model: request.model,
          opening: request.transcript,
        });
        await tx
          .update(researchEngineRuns)
          .set({
            tokensReserved: sql`${researchEngineRuns.tokensReserved} + ${request.reservedTokens}`,
          })
          .where(eq(researchEngineRuns.investigationId, ctx.investigationId));
        return { outcome: 'reserved', callId };
      },
      { requireActive: true },
    );
    return guarded.outcome === 'committed' ? guarded.value : guarded;
  },

  /**
   * Without the guard's mode: a call that started before a cancel request or a closure still closes its reservation,
   * so the ledger keeps what the provider charged.
   */
  async close(ctx, closing) {
    const guarded = await ctx.withAttemptGuard(async (tx): Promise<ClosingOutcome> => {
      await lockEngineRun(tx, ctx.investigationId);
      const usage = {
        inputTokens: closing.usage?.inputTokens ?? null,
        outputTokens: closing.usage?.outputTokens ?? null,
        cacheReadTokens: closing.usage?.cacheReadTokens ?? null,
        cacheWriteTokens: closing.usage?.cacheWriteTokens ?? null,
        costUsd: closing.costUsd.toFixed(COST_SCALE),
      };
      const [closed] = await tx
        .update(researchLlmCalls)
        .set({
          status: closing.status,
          ...usage,
          chargedTokens: closing.chargedTokens,
          closedAt: sql`now()`,
        })
        .where(
          and(
            eq(researchLlmCalls.callId, closing.callId),
            eq(researchLlmCalls.status, 'reserved'),
          ),
        )
        .returning({ reservedTokens: researchLlmCalls.reservedTokens });
      if (closed === undefined) {
        const [row] = await tx
          .select({ status: researchLlmCalls.status })
          .from(researchLlmCalls)
          .where(eq(researchLlmCalls.callId, closing.callId));
        if (row?.status !== 'abandoned') throw new Error(`reservation ${closing.callId} is not open`);
        await closing.writeAnswer?.(tx);
        return 'already_abandoned';
      }
      await closeTranscript(tx, closing.callId, { transcript: closing.transcript, usage });
      await closing.writeAnswer?.(tx);
      await tx
        .update(researchEngineRuns)
        .set({
          tokensReserved: sql`${researchEngineRuns.tokensReserved} - ${closed.reservedTokens}`,
          tokensSpent: sql`${researchEngineRuns.tokensSpent} + ${closing.chargedTokens}`,
        })
        .where(eq(researchEngineRuns.investigationId, ctx.investigationId));
      return 'closed';
    });
    return guarded.outcome === 'fenced' ? 'fenced' : guarded.value;
  },
};
