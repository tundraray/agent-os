import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadRunRegistry } from './thread-run-registry.js';

/** `THREAD_RUN_SETTLE_TIMEOUT_MS` of the tests that exercise the settle timeout. */
const SETTLE_MS = 20;

/** Resolves on the next macrotask, so settled promise chains have run. */
const tick = () => delay(0);

// AC-16.1 (b), KD-6: a delete cancels the thread's runs, waits for their release, and only then runs its action.
describe('ThreadRunRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts only the runs of the deleted thread and runs the action after both are released', async () => {
    const registry = new ThreadRunRegistry(60_000);
    const journal: string[] = [];
    const first = registry.register('t-1');
    const second = registry.register('t-1');
    const other = registry.register('t-2');
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
    const registry = new ThreadRunRegistry(60_000);
    const action = vi.fn(() => Promise.resolve());

    await registry.cancelRunsThen('t-1', action);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('gives a run registered during the delete an aborted signal, and a run after it a live one', async () => {
    const registry = new ThreadRunRegistry(SETTLE_MS);
    const running = registry.register('t-1');
    const deleted = registry.cancelRunsThen('t-1', () => Promise.resolve());

    const duringDelete = registry.register('t-1');
    duringDelete.release();
    running.release();
    await deleted;
    const afterDelete = registry.register('t-1');

    expect(duringDelete.signal.aborted).toBe(true);
    expect(afterDelete.signal.aborted).toBe(false);
  });

  it('on the settle timeout answers after the first action, warns, and deletes again once the run is released', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const registry = new ThreadRunRegistry(SETTLE_MS);
    const stuck = registry.register('t-1');
    const action = vi.fn(() => Promise.resolve());

    await registry.cancelRunsThen('t-1', action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Run outlived thread delete thread=t-1');
    stuck.release();
    await tick();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeated release of the same run', async () => {
    const registry = new ThreadRunRegistry(60_000);
    const released = registry.register('t-1');
    released.release();
    const pending = registry.register('t-1');
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
    const registry = new ThreadRunRegistry(SETTLE_MS);
    const failure = new Error('db down');

    const error: unknown = await registry
      .cancelRunsThen('t-1', () => Promise.reject(failure))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBe(failure);
    expect(registry.register('t-1').signal.aborted).toBe(false);
  });
});

// KD-4 (design-chat-entry.md): the delivery loop asks whether a thread has a chat run in flight; a released run no longer counts.
describe('ThreadRunRegistry.hasRuns', () => {
  it.each<{
    name: string;
    arrange: (registry: ThreadRunRegistry) => void;
    threadId: string;
    expected: boolean;
  }>([
    {
      name: 'before any run is registered → false',
      arrange: () => undefined,
      threadId: 't-1',
      expected: false,
    },
    {
      name: 'after register → true',
      arrange: (registry) => {
        registry.register('t-1');
      },
      threadId: 't-1',
      expected: true,
    },
    {
      name: 'after release → false',
      arrange: (registry) => {
        registry.register('t-1').release();
      },
      threadId: 't-1',
      expected: false,
    },
    {
      name: 'one of two runs released → true',
      arrange: (registry) => {
        registry.register('t-1');
        registry.register('t-1').release();
      },
      threadId: 't-1',
      expected: true,
    },
    {
      name: 'a run of another thread → false',
      arrange: (registry) => {
        registry.register('t-2');
      },
      threadId: 't-1',
      expected: false,
    },
  ])('$name', ({ arrange, threadId, expected }) => {
    const registry = new ThreadRunRegistry(60_000);
    arrange(registry);

    expect(registry.hasRuns(threadId)).toBe(expected);
  });
});
