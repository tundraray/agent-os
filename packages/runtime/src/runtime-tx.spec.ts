import type { Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import { retryingTransaction, TRANSACTION_ATTEMPTS } from './runtime-tx.js';

/** A database whose transaction only runs the work: the helper's retries are what is tested. */
const db = {
  transaction: (work: (tx: unknown) => Promise<unknown>) => work({}),
} as unknown as Database;

const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

function setup() {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;
  return { warn, logger };
}

// Catches: a deadlock or serialization abort escaping to the caller, an endless retry, a retry of
// an error that is not Postgres asking for one.
describe('retryingTransaction', () => {
  it.each(['40P01', '40001'])('runs the work again after SQLSTATE %s', async (code) => {
    const { warn, logger } = setup();
    // drizzle wraps the driver's error: the code is on the cause.
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Failed query', { cause: pgError(code) }))
      .mockResolvedValueOnce('done');

    await expect(retryingTransaction(db, logger, 'tasks.stop', work)).resolves.toBe('done');

    expect(work).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ operation: 'tasks.stop', attempt: 1 });
  });

  it('rethrows the error after the last attempt', async () => {
    const { warn, logger } = setup();
    const deadlock = pgError('40P01');
    const work = vi.fn<() => Promise<never>>().mockRejectedValue(deadlock);

    await expect(retryingTransaction(db, logger, 'tasks.stop', work)).rejects.toBe(deadlock);

    expect(work).toHaveBeenCalledTimes(TRANSACTION_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(TRANSACTION_ATTEMPTS - 1);
  });

  it('does not retry another error', async () => {
    const { warn, logger } = setup();
    const unique = pgError('23505');
    const work = vi.fn<() => Promise<never>>().mockRejectedValue(unique);

    await expect(retryingTransaction(db, logger, 'tasks.create', work)).rejects.toBe(unique);

    expect(work).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
