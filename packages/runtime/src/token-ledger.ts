import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import { type Database, runtimeModelCalls } from '@agent-os/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import { RuntimeError } from './errors.js';
import { type CallUsage, callCostUsd, type ModelPrices } from './model-cost.js';

/** One finished model call as the caller reports it. */
export interface ModelCallRecord {
  ownerId: string;
  /** The task that made the call; absent for a call outside a task. */
  taskId?: string;
  /** `<provider/model>`, a key of the prices file. */
  model: string;
  usage: CallUsage;
}

export interface RecordedCall {
  readonly callId: string;
  readonly costUsd: number;
}

/** Spend of an owner over one calendar month (UTC). */
export interface MonthSpend {
  readonly costUsd: number;
  readonly calls: number;
}

export interface TokenLedgerDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  prices: ModelPrices;
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * The token ledger (design-runtime.md, KD-5, Invariant 8): one row per finished model call, priced
 * at its own model's price. It only records — nothing is reserved or refused for budget. A row is
 * written by its own short statement outside fencing, since the money is spent even when the step
 * is lost, and rows outlive the deletion of their task tree.
 */
export class TokenLedger {
  constructor(private readonly deps: TokenLedgerDeps) {}

  /** Records a finished call; throws `UNKNOWN_MODEL_PRICE` and writes nothing without a price. */
  async record(call: ModelCallRecord): Promise<RecordedCall> {
    const { db, clock, logger, prices } = this.deps;
    const price = prices.get(call.model);
    if (price === undefined) {
      logger.error('model call not recorded: no price for the model', {
        model: call.model,
        ownerId: call.ownerId,
        taskId: call.taskId,
      });
      throw new RuntimeError('UNKNOWN_MODEL_PRICE', `No price is configured for model ${call.model}`);
    }
    const costUsd = callCostUsd(price, call.usage);
    const callId = randomUUID();
    await db.insert(runtimeModelCalls).values({
      callId,
      ownerId: call.ownerId,
      taskId: call.taskId ?? null,
      model: call.model,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      cacheReadTokens: call.usage.cacheReadTokens,
      cacheWriteTokens: call.usage.cacheWriteTokens,
      costUsd,
      calledAt: clock.now(),
    });
    logger.info('model call recorded', {
      callId,
      ownerId: call.ownerId,
      taskId: call.taskId,
      model: call.model,
      ...call.usage,
      costUsd,
    });
    return { callId, costUsd };
  }

  /**
   * Spend of the owner over the month `YYYY-MM`: calls with `called_at` in
   * `[start of the month UTC, start of the next)`. An empty month gives zeros.
   */
  async monthSpend(ownerId: string, month: string): Promise<MonthSpend> {
    const { from, to } = monthWindowUtc(month);
    const [row] = await this.deps.db
      .select({
        costUsd: sql<string>`coalesce(sum(${runtimeModelCalls.costUsd}), 0)`,
        calls: sql<number>`count(*)::int`,
      })
      .from(runtimeModelCalls)
      .where(
        and(
          eq(runtimeModelCalls.ownerId, ownerId),
          gte(runtimeModelCalls.calledAt, from),
          lt(runtimeModelCalls.calledAt, to),
        ),
      );
    return { costUsd: Number(row?.costUsd ?? 0), calls: row?.calls ?? 0 };
  }

  /** The models with a price; the upper layer checks an agent's model against it. */
  pricedModels(): string[] {
    return [...this.deps.prices.keys()];
  }
}

function monthWindowUtc(month: string): { from: Date; to: Date } {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) {
    throw new Error(`Invalid month "${month}": expected YYYY-MM`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)),
    to: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}
