import { ThreadWriteLock } from './thread-write-lock.js';

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

describe('ThreadWriteLock', () => {
  it('runs tasks of one key strictly one after another, in queue order', async () => {
    const lock = new ThreadWriteLock();
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
    const lock = new ThreadWriteLock();
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
      const lock = new ThreadWriteLock();
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
    const lock = new ThreadWriteLock();
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
    const lock = new ThreadWriteLock();
    const failure = new Error('write failed');

    const failedRun = lock.run('t-1', () => Promise.reject(failure));
    const nextRun = lock.run('t-1', () => Promise.resolve('renamed'));

    await expect(failedRun).rejects.toBe(failure);
    await expect(nextRun).resolves.toBe('renamed');
  });
});
