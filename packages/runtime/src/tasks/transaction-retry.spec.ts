import { createLogger } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import {
  inSavepoint,
  mustRetryTransaction,
  withTxRetry,
} from './transaction-retry';

// DC-45 (KD-7): the retry rule of an engine operation that opened its own transaction, and what a
// savepoint may not swallow (KD-6).

/** A Postgres error as drizzle throws it: the driver's error with its SQLSTATE as the cause. */
function pgError(code: string): Error {
  const driverError = Object.assign(new Error(`pg ${code}`), { code });
  return new Error('Failed query: update ...', { cause: driverError });
}

const deadlock = () => pgError('40P01');

/** A database whose transactions run `fn` at once, as joined or opened by `inTransaction`. */
function fakeDb(inTransaction: boolean) {
  const db = {
    inTransaction,
    /** Transactions run, joined or opened. */
    transactions: 0,
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      db.transactions += 1;
      return fn();
    },
    savepoint<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
  return db;
}

function setup(inTransaction = false) {
  const sink = memorySink();
  const logger = createLogger({
    sinks: [sink],
    secrets: [],
    minLevel: 'debug',
  });
  const db = fakeDb(inTransaction);
  const options = { db, logger, operation: 'test.op', taskId: 'task-1' };
  return { sink, db, options };
}

/** `fn` that throws the given errors on its first calls, then answers `done`. */
function failingFirst(errors: readonly Error[]) {
  let calls = 0;
  return vi.fn(() => {
    const error = errors[calls];
    calls += 1;
    return error ? Promise.reject(error) : Promise.resolve('done');
  });
}

describe('mustRetryTransaction', () => {
  it.each([
    ['deadlock 40P01', pgError('40P01'), true],
    ['serialization failure 40001', pgError('40001'), true],
    ['transaction aborted 25P02', pgError('25P02'), true],
    ['connection failure 08006', pgError('08006'), true],
    ['unique violation 23505', pgError('23505'), false],
    ['an error without SQLSTATE', new Error('boom'), false],
    ['a non-error value', 'boom', false],
  ])('%s → %s', (_, error, expected) => {
    expect(mustRetryTransaction(error)).toBe(expected);
  });
});

describe('withTxRetry', () => {
  it.each([
    ['answers at once without an error', [], 'done', 1],
    ['repeats the transaction after a deadlock', [deadlock()], 'done', 2],
    [
      'repeats it up to three times',
      [deadlock(), deadlock(), deadlock()],
      'done',
      4,
    ],
  ])('%s', async (_, errors, expected, calls) => {
    const { db, options, sink } = setup();
    const fn = failingFirst(errors);

    await expect(withTxRetry(options, fn)).resolves.toBe(expected);

    expect(fn).toHaveBeenCalledTimes(calls);
    expect(db.transactions).toBe(calls);
    expect(
      sink.records
        .filter((record) => record.level === 'warn')
        .map((record) => record.fields.retry),
    ).toEqual(errors.map((__, index) => index + 1));
  });

  it('throws the fourth deadlock', async () => {
    const { options } = setup();
    const fourth = deadlock();
    const fn = failingFirst([deadlock(), deadlock(), deadlock(), fourth]);

    await expect(withTxRetry(options, fn)).rejects.toBe(fourth);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not repeat another error', async () => {
    const { options } = setup();
    const other = pgError('23505');
    const fn = failingFirst([other]);

    await expect(withTxRetry(options, fn)).rejects.toBe(other);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not repeat inside the caller's transaction: the caller decides", async () => {
    const { options } = setup(true);
    const error = deadlock();
    const fn = failingFirst([error]);

    await expect(withTxRetry(options, fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('inSavepoint', () => {
  it('answers the value of fn', async () => {
    const { db } = setup(true);
    await expect(inSavepoint(db, () => Promise.resolve(7))).resolves.toEqual({
      ok: true,
      value: 7,
    });
  });

  it('answers another error as its result', async () => {
    const { db } = setup(true);
    const error = new Error('tool broke');
    await expect(inSavepoint(db, () => Promise.reject(error))).resolves.toEqual(
      { ok: false, error },
    );
  });

  it('throws a deadlock, so the whole transaction is repeated', async () => {
    const { db } = setup(true);
    const error = deadlock();
    await expect(inSavepoint(db, () => Promise.reject(error))).rejects.toBe(
      error,
    );
  });
});
