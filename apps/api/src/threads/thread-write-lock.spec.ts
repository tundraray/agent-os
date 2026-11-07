import {
  THREAD_LOCK_NAMESPACE,
  type ThreadLockPool,
  ThreadLockNotObtainedError,
  ThreadWriteLock,
} from './thread-write-lock.js';

type Deferred = {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

const deferred = (): Deferred => {
  let resolve: (value: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets every already-queued promise continuation run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * The lock pool port as a double: `connectTakesMs` moves the clock while a connection is awaited; `connectError` and
 * `lockError` refuse the connection and the advisory lock statement, `commitError` the `COMMIT`. Statements and
 * releases are recorded, and `journal` keeps the two in one order.
 */
function lockPool(
  script: {
    connectTakesMs?: number;
    connectError?: Error;
    lockError?: Error;
    commitError?: Error;
  } = {},
) {
  let nowMs = 0;
  const statements: string[] = [];
  const releases: (Error | undefined)[] = [];
  const journal: string[] = [];
  const pool: ThreadLockPool = {
    connect: () => {
      nowMs += script.connectTakesMs ?? 0;
      if (script.connectError) return Promise.reject(script.connectError);
      return Promise.resolve({
        query: (text: string, values?: unknown[]) => {
          statements.push(values ? `${text} [${values.join(', ')}]` : text);
          journal.push(text);
          if (script.lockError && text.includes('pg_advisory_xact_lock')) {
            return Promise.reject(script.lockError);
          }
          return script.commitError && text === 'COMMIT'
            ? Promise.reject(script.commitError)
            : Promise.resolve({});
        },
        release: (error?: Error) => {
          releases.push(error);
          journal.push(error ? 'release(error)' : 'release()');
        },
      });
    },
  };
  return {
    lock: new ThreadWriteLock(pool, { now: () => nowMs }),
    statements,
    releases,
    journal,
  };
}

/** A lock whose every advisory lock is granted at once. */
const grantingLock = () => lockPool().lock;

describe('ThreadWriteLock', () => {
  it('runs tasks of one key strictly one after another, in queue order', async () => {
    const lock = grantingLock();
    const events: string[] = [];
    const first = deferred();
    const second = deferred();

    const firstRun = lock.run('t-1', async () => {
      events.push('first:start');
      const value = await first.promise;
      events.push('first:end');
      return value;
    });
    const secondRun = lock.run('t-1', async () => {
      events.push('second:start');
      const value = await second.promise;
      events.push('second:end');
      return value;
    });
    await flush();

    expect(events).toEqual(['first:start']);

    second.resolve('manual');
    await flush();
    expect(events).toEqual(['first:start']);

    first.resolve('generated');
    await expect(firstRun).resolves.toBe('generated');
    await expect(secondRun).resolves.toBe('manual');
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('runs tasks of different keys in parallel', async () => {
    const lock = grantingLock();
    const started: string[] = [];
    const blockerOne = deferred();
    const blockerTwo = deferred();

    const runOne = lock.run('t-1', async () => {
      started.push('t-1');
      return blockerOne.promise;
    });
    const runTwo = lock.run('t-2', async () => {
      started.push('t-2');
      return blockerTwo.promise;
    });
    await flush();

    expect(started).toEqual(['t-1', 't-2']);

    blockerTwo.resolve('two');
    await expect(runTwo).resolves.toBe('two');
    blockerOne.resolve('one');
    await expect(runOne).resolves.toBe('one');
  });

  it.each([
    { outcome: 'fulfils', settle: (d: Deferred) => d.resolve('done') },
    {
      outcome: 'rejects',
      settle: (d: Deferred) => d.reject(new Error('boom')),
    },
  ])(
    'holds the key while the task runs and removes it after the task $outcome',
    async ({ settle }) => {
      const lock = grantingLock();
      const task = deferred();

      expect(lock.isHeld('t-1')).toBe(false);
      const run = lock.run('t-1', () => task.promise);
      await flush();
      expect(lock.isHeld('t-1')).toBe(true);

      settle(task);
      await run.catch(() => undefined);

      expect(lock.isHeld('t-1')).toBe(false);
    },
  );

  it('keeps the key held until the last queued task of that key settles', async () => {
    const lock = grantingLock();
    const first = deferred();
    const second = deferred();

    const firstRun = lock.run('t-1', () => first.promise);
    const secondRun = lock.run('t-1', () => second.promise);

    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');
    expect(lock.isHeld('t-1')).toBe(true);

    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
    expect(lock.isHeld('t-1')).toBe(false);
  });

  it('starts the next task of a key after the previous one rejects, and propagates the original error', async () => {
    const lock = grantingLock();
    const failure = new Error('write failed');

    const failedRun = lock.run('t-1', () => Promise.reject(failure));
    const nextRun = lock.run('t-1', () => Promise.resolve('renamed'));

    await expect(failedRun).rejects.toBe(failure);
    await expect(nextRun).resolves.toBe('renamed');
  });

  // KD-5 (UC-E2 across instances): a rejected task frees the advisory lock at once, so another instance's write for
  // the same thread does not wait for the lock timeout — the lock's transaction is rolled back before the connection
  // goes back to the pool. The in-process proof of lifecycle M6; chat-entry INT-3 T3 proves it on the real lock.
  it('a rejected task ends with ROLLBACK then release()', async () => {
    const { lock, journal } = lockPool();
    const failure = new Error('write failed');

    await expect(lock.run('t-1', () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(journal).toEqual([
      'BEGIN',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      'ROLLBACK',
      'release()',
    ]);
  });

  // KD-5: the connection wait and the lock wait share one 15 s limit; the lock gets what the connection left. A failed
  // COMMIT destroys the connection (Postgres ends the lock with it) and the task's result stands.
  const commitLost = new Error('connection lost');
  it.each([
    { connectTakesMs: 0, lockTimeout: '15000ms', releases: [undefined] },
    { connectTakesMs: 4_000, lockTimeout: '11000ms', releases: [undefined] },
    { connectTakesMs: 14_999, lockTimeout: '1ms', releases: [undefined] },
    {
      connectTakesMs: 0,
      lockTimeout: '15000ms',
      commitError: commitLost,
      releases: [commitLost],
    },
  ])(
    'asks for the lock with lock_timeout $lockTimeout after a connection wait of $connectTakesMs ms, and commits after the task (COMMIT failure: $commitError)',
    async ({
      connectTakesMs,
      lockTimeout,
      commitError,
      releases: released,
    }) => {
      const { lock, statements, releases } = lockPool({
        connectTakesMs,
        commitError,
      });

      await expect(
        lock.run('t-1', () => Promise.resolve('done')),
      ).resolves.toBe('done');

      expect(statements).toEqual([
        'BEGIN',
        `SELECT set_config('lock_timeout', $1, true) [${lockTimeout}]`,
        `SELECT pg_advisory_xact_lock($1, hashtext($2)) [${THREAD_LOCK_NAMESPACE}, t-1]`,
        'COMMIT',
      ]);
      expect(releases).toEqual(released);
      expect(lock.isHeld('t-1')).toBe(false);
    },
  );

  // KD-5 (Failure Mode: unavailable boundary): three refusals, one error; `lock_timeout = 0` would lift the limit.
  it.each([
    {
      refusal: 'no lock pool connection within the wait',
      script: {
        connectError: new Error('timeout exceeded when trying to connect'),
      },
      statements: [],
      releases: [],
    },
    {
      refusal:
        'under 1 ms left after the connection wait (no lock is asked for)',
      script: { connectTakesMs: 14_999.5 },
      statements: [],
      releases: [undefined],
    },
    {
      refusal: 'the lock not granted within lock_timeout',
      script: {
        connectTakesMs: 2_000,
        lockError: Object.assign(
          new Error('canceling statement due to lock timeout'),
          { code: '55P03' },
        ),
      },
      statements: [
        'BEGIN',
        "SELECT set_config('lock_timeout', $1, true) [13000ms]",
        `SELECT pg_advisory_xact_lock($1, hashtext($2)) [${THREAD_LOCK_NAMESPACE}, t-1]`,
        'ROLLBACK',
      ],
      releases: [undefined],
    },
  ])(
    'refuses with ThreadLockNotObtainedError and runs no task when $refusal',
    async ({ script, statements, releases }) => {
      const pool = lockPool(script);
      let ran = false;

      await expect(
        pool.lock.run('t-1', () => {
          ran = true;
          return Promise.resolve('done');
        }),
      ).rejects.toBeInstanceOf(ThreadLockNotObtainedError);

      expect(ran).toBe(false);
      expect(pool.statements).toEqual(statements);
      expect(pool.releases).toEqual(releases);
      expect(pool.lock.isHeld('t-1')).toBe(false);
    },
  );
});
