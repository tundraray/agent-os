/** Cancels a scheduled timer; idempotent. */
export type CancelTimer = () => void;

/**
 * Port of time, randomness and timers of the runtime, passed to `createRuntime` so that leases,
 * deadlines, backoff with jitter and polling are deterministic in tests (design-runtime.md,
 * Test Boundaries).
 */
export interface Clock {
  now(): Date;
  /** Uniform random number in `[0, 1)`: the source of backoff jitter. */
  random(): number;
  /** Runs `callback` once after `ms`. */
  setTimer(ms: number, callback: () => void): CancelTimer;
}

/** The real clock of the process. */
export const systemClock: Clock = {
  now: () => new Date(),
  random: () => Math.random(),
  setTimer: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
