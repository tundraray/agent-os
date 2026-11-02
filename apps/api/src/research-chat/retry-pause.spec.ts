import fc from 'fast-check';
import { retryPauseMs } from './retry-pause.js';

// KD-4: a failed answer write is retried after a pause that starts at RUNTIME_POLL_MS and doubles up to 16 times it.
// Risk: the pause shrinks between attempts, falls under the poll period, or the ceiling is not 16 × RUNTIME_POLL_MS.
describe('retryPauseMs', () => {
  it('starts at the poll period, doubles and stops at 16 times it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        (pollMs, failures) => {
          const pause = retryPauseMs(pollMs, failures);
          const next = retryPauseMs(pollMs, failures + 1);

          expect(pause).toBeGreaterThanOrEqual(pollMs);
          expect(pause).toBeLessThanOrEqual(16 * pollMs);
          expect(next).toBeGreaterThanOrEqual(pause);
          expect(next === 2 * pause || next === 16 * pollMs).toBe(true);
        },
      ),
    );
  });

  it.each<[number, number]>([
    [1, 500],
    [2, 1_000],
    [4, 4_000],
    [5, 8_000],
    [6, 8_000],
    [1_000, 8_000],
  ])(
    'after %i failures at RUNTIME_POLL_MS 500 pauses %i ms',
    (failures, expected) => {
      expect(retryPauseMs(500, failures)).toBe(expected);
    },
  );
});
