import { describe, expect, it } from 'vitest';
import { attemptLimit, queueLimitMs } from './task-limits.js';

// AC-20.1, DC-5 (design-lifecycle.md KD-3): the queue limit is the smaller of RUNTIME_QUEUE_WAIT_MS
// and the task's total deadline. Defect: the total deadline is ignored when it is the shorter one.
describe('queueLimitMs', () => {
  it.each([
    ['the setting is below the total deadline', 30_000, 600_000, 30_000],
    ['the setting is above the total deadline', 600_000, 1_000, 1_000],
    ['the setting equals the total deadline', 60_000, 60_000, 60_000],
  ])(
    'is the smaller of the two when %s',
    (_, queueWaitMs, deadlineMs, expected) => {
      expect(queueLimitMs(queueWaitMs, deadlineMs)).toBe(expected);
    },
  );
});

// AC-20.2, AC-20.3, DC-6 (design-lifecycle.md KD-3): an attempt lives the smaller of
// RUNTIME_ATTEMPT_MS and the time left to the total deadline; only a setting that ends first aborts
// with `attempt_timeout`. Defects: the attempt outlives the total deadline; a deadline that ends
// first is retried as a timed-out attempt.
describe('attemptLimit', () => {
  it.each([
    [
      'the setting is below the time left',
      900_000,
      3_600_000,
      { ms: 900_000, reason: 'attempt_timeout' },
    ],
    [
      'the setting is above the time left',
      900_000,
      60_000,
      { ms: 60_000, reason: 'deadline' },
    ],
    [
      'the setting equals the time left',
      60_000,
      60_000,
      { ms: 60_000, reason: 'deadline' },
    ],
    ['no time is left', 900_000, 0, { ms: 0, reason: 'deadline' }],
    [
      'the deadline has already passed',
      900_000,
      -5_000,
      { ms: 0, reason: 'deadline' },
    ],
  ])('when %s', (_, attemptMs, msToDeadline, expected) => {
    expect(attemptLimit(attemptMs, msToDeadline)).toEqual(expected);
  });
});
