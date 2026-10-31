import type { Clock } from '@agent-os/runtime';
import { describe, expect, it } from 'vitest';
import { backoffDelayMs, sleepUnlessAborted } from './backoff.js';

// KD-7, Settings: full jitter — a random delay in [0, min(cap, base × 2^n)]; the signal interrupts the wait.

const SETTINGS = { retryBaseMs: 200, retryCapMs: 5_000 };

describe('backoffDelayMs', () => {
  it.each([
    { random: 0, retryIndex: 0, expected: 0 },
    { random: 0.5, retryIndex: 0, expected: 100 },
    { random: 0.999, retryIndex: 0, expected: 199.8 },
    { random: 0.5, retryIndex: 3, expected: 800 },
    { random: 0.999, retryIndex: 4, expected: 3_196.8 },
    // base × 2^5 = 6 400 is above the cap: the cap bounds the range.
    { random: 0.999, retryIndex: 5, expected: 4_995 },
    { random: 0.5, retryIndex: 30, expected: 2_500 },
  ])('retry $retryIndex with random $random waits $expected ms', ({ random, retryIndex, expected }) => {
    expect(backoffDelayMs(retryIndex, SETTINGS, () => random)).toBeCloseTo(expected, 6);
  });
});

interface ManualTimers {
  clock: Pick<Clock, 'setTimer'>;
  scheduled: { ms: number; cancelled: boolean; fire: () => void }[];
}

function manualTimers(): ManualTimers {
  const scheduled: ManualTimers['scheduled'] = [];
  return {
    scheduled,
    clock: {
      setTimer(ms, callback) {
        const timer = { ms, cancelled: false, fire: callback };
        scheduled.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  };
}

describe('sleepUnlessAborted', () => {
  it('waits the delay on the injected clock when the signal stays quiet', async () => {
    const timers = manualTimers();
    const slept = sleepUnlessAborted(750, timers.clock, new AbortController().signal);

    expect(timers.scheduled.map((timer) => timer.ms)).toEqual([750]);
    timers.scheduled[0].fire();
    await expect(slept).resolves.toBe('elapsed');
  });

  it('ends at once and cancels the timer when the signal aborts during the delay', async () => {
    const timers = manualTimers();
    const controller = new AbortController();
    const slept = sleepUnlessAborted(5_000, timers.clock, controller.signal);

    controller.abort({ kind: 'deadline' });

    await expect(slept).resolves.toBe('aborted');
    expect(timers.scheduled[0].cancelled).toBe(true);
  });

  it('does not start a delay on an already aborted signal', async () => {
    const timers = manualTimers();
    const controller = new AbortController();
    controller.abort({ kind: 'cancelled' });

    await expect(sleepUnlessAborted(5_000, timers.clock, controller.signal)).resolves.toBe('aborted');
    expect(timers.scheduled).toEqual([]);
  });
});
