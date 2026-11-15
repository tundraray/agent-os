import type { Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';

/** A transaction of the runtime; every data layer method and every `commit` of a step takes one (ADR-0001). */
export type RuntimeTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Runs of a transaction that Postgres keeps aborting, the first one included. */
export const TRANSACTION_ATTEMPTS = 5;
/** The pause before retry `n` is `n` times this, jittered by ±50 %. */
const RETRY_BASE_MS = 20;
/** SQLSTATE of a transaction Postgres aborted to let others go on: deadlock, serialization failure. */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);

/** Whether the error, or a cause of it (drizzle wraps the driver's error), has a retryable SQLSTATE. */
function isRetryable(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) return true;
  }
  return false;
}

/**
 * `db.transaction(work)`, run again when Postgres aborts it with a deadlock (40P01) or a
 * serialization failure (40001): up to {@link TRANSACTION_ATTEMPTS} runs with a short jittered
 * pause, then the error is rethrown. `work` runs once per attempt, so everything it does must be
 * inside `tx` (rolled back with it) or safe to repeat; its guards are re-read on each run.
 */
export async function retryingTransaction<T>(
  db: Database,
  logger: Logger,
  operation: string,
  work: (tx: RuntimeTx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (attempt >= TRANSACTION_ATTEMPTS || !isRetryable(error)) throw error;
      const retryInMs = Math.round(RETRY_BASE_MS * attempt * (0.5 + Math.random()));
      logger.warn('transaction aborted by Postgres, retrying', {
        operation,
        attempt,
        retryInMs,
        error,
      });
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
}
