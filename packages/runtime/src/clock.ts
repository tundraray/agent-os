/** Cancels a scheduled timer; idempotent. */
export type CancelTimer = () => void;

/**
 * Port of time and timers of the runtime (the `CLOCK` provider), replaceable so that deadlines and
 * polling are deterministic in tests (design-runtime.md, Test Boundaries).
 */
export interface Clock {
  now(): Date;
  /** Runs `callback` once after `ms`. */
  setTimer(ms: number, callback: () => void): CancelTimer;
}

/** The real clock of the process. */
export const systemClock: Clock = {
  now: () => new Date(),
  setTimer: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
