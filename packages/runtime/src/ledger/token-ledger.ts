import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import { RuntimeModelCallsRepository } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../clock';
import { CLOCK, RUNTIME_LOGGER } from '../runtime.tokens';
import { type CallUsage, callCostUsd, type ModelPrice } from './model-cost';
import { monthWindowUtc } from './month';

/** One finished model call as the caller reports it. */
export interface ModelCallRecord {
  /** The employee whose spend it is; `null` for the platform's own call, which no employee's month counts. */
  ownerId: string | null;
  /** The task that made the call; absent for a call outside a task. */
  taskId?: string;
  /** `<provider/model>`, an id of the model catalogue. */
  model: string;
  /** The model's price that came with the access verdict for this call (ADR-0015). */
  price: ModelPrice;
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

interface TokenLedgerDeps {
  rows: RuntimeModelCallsRepository;
  clock: Clock;
  logger: Logger;
}

/**
 * The token ledger (design-runtime.md, KD-5, Invariant 8): one row per finished model call, priced
 * at the price the call carries (ADR-0015: the runtime keeps no price table). It only records —
 * nothing is reserved or refused for budget. A row is written by its own short statement outside
 * fencing, since the money is spent even when the step is lost, and rows outlive the deletion of
 * their task tree.
 */
@Injectable()
export class TokenLedger {
  private readonly deps: TokenLedgerDeps;

  constructor(
    @Inject(RuntimeModelCallsRepository) rows: RuntimeModelCallsRepository,
    @Inject(CLOCK) clock: Clock,
    @Inject(RUNTIME_LOGGER) logger: Logger,
  ) {
    this.deps = { rows, clock, logger: logger.child({ service: 'ledger' }) };
  }

  /** Records a finished call at the price of its record. */
  async record(call: ModelCallRecord): Promise<RecordedCall> {
    const { rows, clock, logger } = this.deps;
    const costUsd = callCostUsd(call.price, call.usage);
    const callId = randomUUID();
    await rows.insert({
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
    const row = await this.deps.rows.sumOwned(ownerId, monthWindowUtc(month));
    return { costUsd: Number(row?.costUsd ?? 0), calls: row?.calls ?? 0 };
  }

  /**
   * Spend of the owner over the month `YYYY-MM` split by model, in the window of
   * {@link monthSpend}: model -> USD. A model with no call in the month is absent.
   */
  async monthSpendByModel(
    ownerId: string,
    month: string,
  ): Promise<ReadonlyMap<string, number>> {
    const spent = await this.deps.rows.sumOwnedByModel(
      ownerId,
      monthWindowUtc(month),
    );
    return new Map(spent.map((row) => [row.model, Number(row.costUsd)]));
  }
}
