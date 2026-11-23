import type { Logger } from '@agent-os/common';
import type { Db } from '@agent-os/db';

/** SQLSTATE deadlock_detected: Postgres rolled this transaction back to let the other one pass. */
const DEADLOCK = '40P01';

/** SQLSTATE in_failed_sql_transaction: the transaction already failed and takes no more statements. */
const FAILED_TRANSACTION = '25P02';

/** Repeats of a transaction after a deadlock; the next deadlock is thrown (KD-7). */
const DEADLOCK_RETRIES = 3;

/** The SQLSTATE of the error or of a cause of it (drizzle wraps the driver's error); `undefined` — none. */
function sqlStateOf(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * Whether after this error the transaction cannot go on and must be repeated whole: a deadlock or
 * another transaction rollback (class `40`), a failed transaction (`25P02`) or a lost connection
 * (class `08`). A savepoint never swallows such an error (KD-6, KD-7).
 */
export function mustRetryTransaction(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state === undefined) return false;
  return (
    state.startsWith('40') ||
    state === FAILED_TRANSACTION ||
    state.startsWith('08')
  );
}

/** What {@link withTxRetry} needs to name the operation in its log. */
export interface TxRetryOptions {
  db: Pick<Db, 'inTransaction' | 'transaction'>;
  logger: Logger;
  /** The engine operation, e.g. `tasks.stop`. */
  operation: string;
  /** The task the transaction is for, when known before it. */
  taskId?: string;
}

/**
 * Runs `fn` in a transaction of an engine operation (KD-7). Inside a transaction open here `fn`
 * joins it and nothing is caught: the caller's transaction rolls back whole and the caller decides.
 * Otherwise the operation opened the transaction itself and repeats it after a deadlock up to
 * {@link DEADLOCK_RETRIES} times, logging each repeat; any other error, and the next deadlock, is
 * thrown. Every engine transaction guards its writes by status and attempt, so a repeat is safe.
 */
export async function withTxRetry<T>(
  options: TxRetryOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { db, logger, operation, taskId } = options;
  if (db.inTransaction) return db.transaction(fn);
  for (let retry = 1; ; retry += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      if (retry > DEADLOCK_RETRIES || sqlStateOf(error) !== DEADLOCK)
        throw error;
      logger.warn('engine transaction deadlocked; repeating it', {
        operation,
        taskId,
        retry,
        maxRetries: DEADLOCK_RETRIES,
        error,
      });
    }
  }
}

/** How a savepoint ended: the value of `fn`, or the error that rolled back only its writes. */
export type SavepointResult<T> =
  { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `fn` in a savepoint of the transaction open here. An error of `fn` rolls back only its own
 * writes and comes back as the result, except one after which the transaction cannot go on
 * ({@link mustRetryTransaction}): that one is thrown, so the whole transaction is repeated.
 */
export async function inSavepoint<T>(
  db: Pick<Db, 'savepoint'>,
  fn: () => Promise<T>,
): Promise<SavepointResult<T>> {
  try {
    return { ok: true, value: await db.savepoint(fn) };
  } catch (error) {
    if (mustRetryTransaction(error)) throw error;
    return { ok: false, error };
  }
}
