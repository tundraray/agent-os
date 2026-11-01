import { randomUUID } from 'node:crypto';
import { researchEngineRuns, researchLlmCalls } from '@agent-os/db';
import type { RuntimeTx, TaskContext } from '@agent-os/runtime';
import { and, eq, sql } from 'drizzle-orm';
import type { CallUsage } from './cost.js';

export type ModelRole = 'plan' | 'controller' | 'worker' | 'verifier' | 'synthesis';

/** A reservation to record before the call (KD-4): counted input + margin + output cap. */
export interface ReservationRequest {
  readonly role: ModelRole;
  readonly model: string;
  readonly countedInputTokens: number;
  readonly reservedTokens: number;
}

export type ReservationOutcome =
  | { readonly outcome: 'reserved'; readonly callId: string }
  | {
      readonly outcome: 'refused';
      readonly code: 'task_tokens_exhausted' | 'investigation_tokens_exhausted';
    }
  | { readonly outcome: 'fenced' };

/** How a reservation closes: `settled` by the answer's usage, `failed` by what a provider error reported. */
export interface ReservationClosing {
  readonly callId: string;
  readonly status: 'settled' | 'failed';
  /** Null when the provider reported no usage. */
  readonly usage: CallUsage | null;
  readonly chargedTokens: number;
  readonly costUsd: number;
}

/** The call ledger port of `ModelGateway`; every write goes through `withAttemptGuard`. */
export interface CallLedger {
  reserve(ctx: TaskContext, request: ReservationRequest): Promise<ReservationOutcome>;
  close(ctx: TaskContext, closing: ReservationClosing): Promise<'closed' | 'fenced'>;
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

/** The Postgres ledger: rows of `research_llm_calls` and the counters of `research_engine_runs`. */
export const postgresCallLedger: CallLedger = {
  async reserve(ctx, request) {
    const guarded = await ctx.withAttemptGuard(
      async (tx): Promise<ReservationOutcome> => {
        const run = await lockEngineRun(tx, ctx.investigationId);
        if (
          run.tokensSpent + run.tokensReserved + request.reservedTokens >
          run.tokenBudget
        ) {
          return { outcome: 'refused', code: 'investigation_tokens_exhausted' };
        }
        const held = await taskTokensHeld(tx, ctx.taskId);
        if (held + request.reservedTokens > ctx.budget.maxTokens) {
          return { outcome: 'refused', code: 'task_tokens_exhausted' };
        }
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
        await tx
          .update(researchEngineRuns)
          .set({
            tokensReserved: sql`${researchEngineRuns.tokensReserved} + ${request.reservedTokens}`,
          })
          .where(eq(researchEngineRuns.investigationId, ctx.investigationId));
        return { outcome: 'reserved', callId };
      },
    );
    return guarded.outcome === 'fenced' ? guarded : guarded.value;
  },

  async close(ctx, closing) {
    const guarded = await ctx.withAttemptGuard(async (tx) => {
      await lockEngineRun(tx, ctx.investigationId);
      const [closed] = await tx
        .update(researchLlmCalls)
        .set({
          status: closing.status,
          inputTokens: closing.usage?.inputTokens ?? null,
          outputTokens: closing.usage?.outputTokens ?? null,
          cacheReadTokens: closing.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: closing.usage?.cacheWriteTokens ?? null,
          chargedTokens: closing.chargedTokens,
          costUsd: closing.costUsd.toFixed(COST_SCALE),
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
        throw new Error(`reservation ${closing.callId} is not open`);
      }
      await tx
        .update(researchEngineRuns)
        .set({
          tokensReserved: sql`${researchEngineRuns.tokensReserved} - ${closed.reservedTokens}`,
          tokensSpent: sql`${researchEngineRuns.tokensSpent} + ${closing.chargedTokens}`,
        })
        .where(eq(researchEngineRuns.investigationId, ctx.investigationId));
    });
    return guarded.outcome === 'fenced' ? 'fenced' : 'closed';
  },
};
