import type { Clock } from '@agent-os/runtime';
import type { EngineLogger } from '../ports.js';
import { readSourceSnapshots, type SourceSnapshots } from './source-snapshots.js';

// KD-7 (design-self-check.md, Contract Definitions: Engine.startInvestigation): the slice of every source is read at
// the same time, each read bounded by its own 2 second deadline; a slow or failed read gives an empty slice, nothing
// rejects. The happy path with the real fixture is INT-4 R1.

/** A clock whose timers fire only when the test moves time forward. */
function manualClock() {
  let nowMs = 0;
  let timers: { dueMs: number; callback: () => void }[] = [];
  const clock: Clock = {
    now: () => new Date(nowMs),
    random: () => 0,
    setTimer: (ms, callback) => {
      const timer = { dueMs: nowMs + ms, callback };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
  };
  const advance = async (ms: number): Promise<void> => {
    nowMs += ms;
    const due = timers.filter((t) => t.dueMs <= nowMs);
    timers = timers.filter((t) => t.dueMs > nowMs);
    for (const timer of due) timer.callback();
    await flush();
  };
  return { clock, advance };
}

/** Lets every settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Behaviour = { kind: 'answers'; snapshot: string } | { kind: 'refuses' } | { kind: 'hangs' };

/** A source double: each source answers, refuses or never answers (ignoring its signal); the signals are kept. */
function sourceDouble(behaviours: Record<string, Behaviour>) {
  const signals = new Map<string, AbortSignal>();
  const sources = {
    currentSnapshot: (sourceId: string, signal: AbortSignal): Promise<string> => {
      signals.set(sourceId, signal);
      const behaviour = behaviours[sourceId];
      if (behaviour?.kind === 'answers') return Promise.resolve(behaviour.snapshot);
      if (behaviour?.kind === 'refuses') return Promise.reject(new Error('no adapter'));
      return new Promise<string>(() => undefined);
    },
  };
  return { sources, signals };
}

const logger: EngineLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe('readSourceSnapshots', () => {
  it.each<{
    name: string;
    behaviours: Record<string, Behaviour>;
    advanceMs: number;
    expected: SourceSnapshots;
    aborted: string[];
  }>([
    {
      name: 'records a slice that was read',
      behaviours: { fixture: { kind: 'answers', snapshot: 'fx-v1-2157485c' } },
      advanceMs: 0,
      expected: { fixture: 'fx-v1-2157485c' },
      aborted: [],
    },
    {
      name: 'records an empty slice when the read is refused',
      behaviours: { fixture: { kind: 'refuses' } },
      advanceMs: 0,
      expected: { fixture: null },
      aborted: [],
    },
    {
      name: 'records an empty slice and aborts the read when the source does not answer in 2 seconds',
      behaviours: { fixture: { kind: 'hangs' } },
      advanceMs: 2_000,
      expected: { fixture: null },
      aborted: ['fixture'],
    },
    {
      name: 'reads two hanging sources together: both are given up after 2 seconds, not 4',
      behaviours: { fixture: { kind: 'hangs' }, logs: { kind: 'hangs' } },
      advanceMs: 2_000,
      expected: { fixture: null, logs: null },
      aborted: ['fixture', 'logs'],
    },
    {
      name: 'keeps the slices that were read next to a source that failed',
      behaviours: { fixture: { kind: 'answers', snapshot: 'fx-sc-16708327' }, logs: { kind: 'refuses' } },
      advanceMs: 0,
      expected: { fixture: 'fx-sc-16708327', logs: null },
      aborted: [],
    },
  ])('$name', async ({ behaviours, advanceMs, expected, aborted }) => {
    const { clock, advance } = manualClock();
    const { sources, signals } = sourceDouble(behaviours);
    let settled: { snapshots: SourceSnapshots } | { error: unknown } | undefined;

    readSourceSnapshots({ sources, clock, logger }, Object.keys(behaviours)).then(
      (snapshots) => (settled = { snapshots }),
      (error: unknown) => (settled = { error }),
    );
    await flush();
    if (advanceMs > 0) {
      // One millisecond before the deadline nothing is given up yet.
      await advance(advanceMs - 1);
      expect(settled).toBeUndefined();
      await advance(1);
    }

    expect(settled).toEqual({ snapshots: expected });
    const abortedIds = [...signals].filter(([, signal]) => signal.aborted).map(([sourceId]) => sourceId);
    expect(abortedIds).toEqual(aborted);
  });
});
