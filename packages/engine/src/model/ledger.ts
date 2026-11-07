import { randomUUID } from 'node:crypto';
import { researchEngineRuns, researchLlmCalls } from '@agent-os/db';
import type { RuntimeTx, TaskContext } from '@agent-os/runtime';
import { and, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import {
  closeTranscript,
  insertOpenTranscript,
  type TranscriptClosing,
  type TranscriptOpening,
} from '../transcripts/transcript-writes.js';
import type { CallUsage } from './cost.js';
import { decideReserve } from './reserve-rule.js';

export type ModelRole = 'plan' | 'controller' | 'worker' | 'verifier' | 'synthesis';

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

/** Tokens the task holds across all its attempts: open reservations whole, closed rows as charged. */
async function taskTokensHeld(tx: RuntimeTx, taskId: string): Promise<number> {
  const [row] = await tx
    .select({
      held: sql<number>`coalesce(sum(case when ${researchLlmCalls.status} = 'reserved' then ${researchLlmCalls.reservedTokens} else ${researchLlmCalls.chargedTokens} end), 0)::int`,
    })
    .from(researchLlmCalls)
    .where(eq(researchLlmCalls.taskId, taskId));
  return row?.held ?? 0;
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
        const decided = decideReserve({
          ...run,
          taskTokensHeld: await taskTokensHeld(tx, ctx.taskId),
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
        if (row?.status === 'abandoned') return 'already_abandoned';
        throw new Error(`reservation ${closing.callId} is not open`);
      }
      await closeTranscript(tx, closing.callId, { transcript: closing.transcript, usage });
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
