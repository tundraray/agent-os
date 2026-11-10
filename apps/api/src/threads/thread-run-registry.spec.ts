import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type RunMark,
  type ThreadRunHandle,
  type ThreadRunMarks,
  ThreadRunRegistry,
} from './thread-run-registry.js';

/** `THREAD_RUN_SETTLE_TIMEOUT_MS` of the tests that exercise the settle timeout. */
const SETTLE_MS = 20;

/** The registry's `now()` at the start of every test. */
const START = Date.UTC(2026, 10, 7, 9, 0, 0);

/** Resolves on the next macrotask, so settled promise chains have run. */
const tick = () => delay(0);

/** A clock moved by hand: `advance` fires the timers that fall due, in order, and lets their promise chains settle. */
function manualClock() {
  let now = START;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => new Date(now),
    setTimer: (ms: number, callback: () => void) => {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        const [due] = [...timers]
          .filter((timer) => timer.at <= end)
          .sort((a, b) => a.at - b.at);
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.callback();
        await tick();
      }
      now = end;
      await tick();
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

/**
 * `app.chat_thread_runs` in memory with the semantics of the Postgres port: an insert deletes the marks whose lease
 * ended at or before its `now`; a mark is live while its lease ends after `now`. `renew` records each lease it writes.
 */
function memoryMarks() {
  const rows = new Map<string, RunMark>();
  const renewals: { runId: string; leaseExpiresAt: number }[] = [];
  const marks = {
    insert: vi.fn((mark: RunMark, now: Date) => {
      for (const [runId, row] of rows) {
        if (row.leaseExpiresAt <= now) rows.delete(runId);
      }
      rows.set(mark.runId, mark);
      return Promise.resolve();
    }),
    renew: vi.fn((runId: string, leaseExpiresAt: Date) => {
      renewals.push({ runId, leaseExpiresAt: leaseExpiresAt.getTime() });
      const row = rows.get(runId);
      if (row) rows.set(runId, { ...row, leaseExpiresAt });
      return Promise.resolve();
    }),
    remove: vi.fn((runId: string) => {
      rows.delete(runId);
      return Promise.resolve();
    }),
    hasLive: (threadId: string, now: Date) =>
      Promise.resolve(
        [...rows.values()].some(
          (row) => row.threadId === threadId && row.leaseExpiresAt > now,
        ),
      ),
  } satisfies ThreadRunMarks;
  return { marks, rows, renewals };
}

function setup(settleTimeoutMs = 60_000) {
  const clock = manualClock();
  const store = memoryMarks();
  const registry = new ThreadRunRegistry({
    settleTimeoutMs,
    marks: store.marks,
    clock,
  });
  return { registry, clock, ...store };
}

/** A run as the chat registers it: in this process first, its mark written once the ownership check has passed. */
async function registerMarked(
  registry: ThreadRunRegistry,
  threadId: string,
): Promise<ThreadRunHandle> {
  const run = registry.register(threadId);
  await run.mark();
  return run;
}

// AC-16.1 (b), KD-6: a delete cancels the thread's runs, waits for their release, and only then runs its action.
describe('ThreadRunRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts only the runs of the deleted thread and runs the action after both are released', async () => {
    const { registry } = setup();
    const journal: string[] = [];
    const first = await registerMarked(registry, 't-1');
    const second = await registerMarked(registry, 't-1');
    const other = await registerMarked(registry, 't-2');
    for (const run of [first, second]) {
      run.signal.addEventListener('abort', () => journal.push('abort'));
    }
    const action = vi.fn(() => {
      journal.push('action');
      return Promise.resolve();
    });

    const deleted = registry.cancelRunsThen('t-1', action);
    await tick();
    expect(action).not.toHaveBeenCalled();
    journal.push('release');
    first.release();
    await tick();
    expect(action).not.toHaveBeenCalled();
    journal.push('release');
    second.release();
    await deleted;

    expect(journal).toEqual(['abort', 'abort', 'release', 'release', 'action']);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it('runs the action at once when the thread has no runs', async () => {
    const { registry } = setup();
    const action = vi.fn(() => Promise.resolve());

    await registry.cancelRunsThen('t-1', action);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('gives a run registered during the delete an aborted signal, and a run after it a live one', async () => {
    const { registry } = setup(SETTLE_MS);
    const running = await registerMarked(registry, 't-1');
    const deleted = registry.cancelRunsThen('t-1', () => Promise.resolve());

    const duringDelete = await registerMarked(registry, 't-1');
    duringDelete.release();
    running.release();
    await deleted;
    const afterDelete = await registerMarked(registry, 't-1');

    expect(duringDelete.signal.aborted).toBe(true);
    expect(afterDelete.signal.aborted).toBe(false);
  });

  it('on the settle timeout answers after the first action, warns, and deletes again once the run is released', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { registry } = setup(SETTLE_MS);
    const stuck = await registerMarked(registry, 't-1');
    const action = vi.fn(() => Promise.resolve());

    await registry.cancelRunsThen('t-1', action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Run outlived thread delete thread=t-1');
    stuck.release();
    await tick();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeated release of the same run', async () => {
    const { registry } = setup();
    const released = await registerMarked(registry, 't-1');
    released.release();
    const pending = await registerMarked(registry, 't-1');
    const action = vi.fn(() => Promise.resolve());

    const deleted = registry.cancelRunsThen('t-1', action);
    released.release();
    await tick();

    expect(action).not.toHaveBeenCalled();
    pending.release();
    await deleted;
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('rejects with the same error object when the action fails, and clears the deleting mark', async () => {
    const { registry } = setup(SETTLE_MS);
    const failure = new Error('db down');

    const error: unknown = await registry
      .cancelRunsThen('t-1', () => Promise.reject(failure))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBe(failure);
    expect((await registerMarked(registry, 't-1')).signal.aborted).toBe(false);
  });

  it('rejects the mark write with its error and leaves no run for a delete to wait for', async () => {
    const { registry, marks, clock } = setup();
    const failure = new Error('db down');
    marks.insert.mockRejectedValueOnce(failure);
    const action = vi.fn(() => Promise.resolve());

    const run = registry.register('t-1');
    const error: unknown = await run.mark().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await registry.cancelRunsThen('t-1', action);

    expect(error).toBe(failure);
    expect(action).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('a run released while its mark write is in flight removes the mark and starts no renewal', async () => {
    const { registry, clock, rows, marks } = setup();
    let finishInsert: () => void = () => undefined;
    const insertGate = new Promise<void>((resolve) => {
      finishInsert = resolve;
    });
    marks.insert.mockImplementationOnce(async (mark: RunMark) => {
      await insertGate;
      rows.set(mark.runId, mark);
    });

    const run = registry.register('t-1');
    const marking = run.mark();
    run.release();
    expect(rows.size).toBe(0);
    finishInsert();
    await marking;
    await tick();

    expect(marks.remove).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });
});

// design-lifecycle.md KD-6, Runtime settings: a run's mark has a 30 s lease, extended every 10 s until the run is
// released; `release` deletes it. Failure mode: a mark that is not renewed, outlives its run, or expires early.
describe('ThreadRunRegistry run marks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the mark with a lease of 30 s and renews it every 10 s from the time of the pulse', async () => {
    const { registry, clock, marks, renewals } = setup();

    await registerMarked(registry, 't-1');
    await clock.advance(9_999);
    expect(renewals).toEqual([]);
    await clock.advance(1);
    await clock.advance(10_000);

    expect(marks.insert).toHaveBeenCalledWith(
      {
        runId: expect.any(String),
        threadId: 't-1',
        leaseExpiresAt: new Date(START + 30_000),
      },
      new Date(START),
    );
    const [[{ runId }]] = marks.insert.mock.calls;
    expect(renewals).toEqual([
      { runId, leaseExpiresAt: START + 40_000 },
      { runId, leaseExpiresAt: START + 50_000 },
    ]);
    // A run 2 minutes on is still seen on every instance: its renewals keep the mark live.
    await clock.advance(100_000);
    expect(await registry.hasRuns('t-1')).toBe(true);
  });

  it('deletes the mark on release and renews it no more', async () => {
    const { registry, clock, rows, renewals } = setup();
    const run = await registerMarked(registry, 't-1');

    run.release();
    await tick();
    await clock.advance(30_000);

    expect(rows.size).toBe(0);
    expect(renewals).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('logs a failed renewal and renews again on the next pulse', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { registry, clock, marks, renewals } = setup();
    await registerMarked(registry, 't-1');
    marks.renew.mockRejectedValueOnce(new Error('db down'));

    await clock.advance(20_000);

    expect(warn).toHaveBeenCalledWith(
      'Run mark not renewed thread=t-1 reason=Error',
    );
    expect(renewals.map((renewal) => renewal.leaseExpiresAt)).toEqual([
      START + 50_000,
    ]);
    expect(await registry.hasRuns('t-1')).toBe(true);
  });
});

// KD-4 (design-chat-entry.md), KD-6 (design-lifecycle.md): the delivery loop asks whether a thread has a chat run in
// flight on any instance; a run without its mark yet, a released run, or a mark whose lease has ended does not count
// (the lease of a crashed instance's mark is proven on Postgres by agent-quality-lifecycle INT-2 M5).
describe('ThreadRunRegistry.hasRuns', () => {
  it.each<{
    name: string;
    arrange: (registry: ThreadRunRegistry) => Promise<unknown>;
    threadId: string;
    expected: boolean;
  }>([
    {
      name: 'before any run is registered → false',
      arrange: () => Promise.resolve(),
      threadId: 't-1',
      expected: false,
    },
    {
      name: 'registered in this process, mark not written yet → false',
      arrange: (registry) => Promise.resolve(registry.register('t-1')),
      threadId: 't-1',
      expected: false,
    },
    {
      name: 'after the mark is written → true',
      arrange: (registry) => registerMarked(registry, 't-1'),
      threadId: 't-1',
      expected: true,
    },
    {
      name: 'after release → false',
      arrange: async (registry) =>
        (await registerMarked(registry, 't-1')).release(),
      threadId: 't-1',
      expected: false,
    },
    {
      name: 'one of two runs released → true',
      arrange: async (registry) => {
        await registerMarked(registry, 't-1');
        (await registerMarked(registry, 't-1')).release();
      },
      threadId: 't-1',
      expected: true,
    },
    {
      name: 'a run of another thread → false',
      arrange: (registry) => registerMarked(registry, 't-2'),
      threadId: 't-1',
      expected: false,
    },
  ])('$name', async ({ arrange, threadId, expected }) => {
    const { registry } = setup();
    await arrange(registry);

    expect(await registry.hasRuns(threadId)).toBe(expected);
  });
});
