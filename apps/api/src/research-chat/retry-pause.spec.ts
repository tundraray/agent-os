import { retryPauseMs } from './retry-pause.js';

// KD-4: a failed answer write is retried after a pause that starts at RUNTIME_POLL_MS and doubles up to 16 times it.
// Risk: the pause shrinks between attempts, falls under the poll period, or the ceiling is not 16 × RUNTIME_POLL_MS.
describe('retryPauseMs', () => {
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
