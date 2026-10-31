import type { Clock } from '@agent-os/runtime';

export interface BackoffSettings {
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
}

/**
 * Full jitter (KD-7): a uniform random delay in [0, min(cap, base × 2^n)] before retry `n` (0 for the first
 * retry). `random` is the `Clock` port's source, so tests fix the jitter.
 */
export function backoffDelayMs(retryIndex: number, settings: BackoffSettings, random: () => number): number {
  const ceiling = Math.min(settings.retryCapMs, settings.retryBaseMs * 2 ** retryIndex);
  return random() * ceiling;
}

/** Waits `ms` on the clock's timer; the signal ends the wait at once (AC-20.2). */
export function sleepUnlessAborted(
  ms: number,
  clock: Pick<Clock, 'setTimer'>,
  signal: AbortSignal,
): Promise<'elapsed' | 'aborted'> {
  if (signal.aborted) {
    return Promise.resolve('aborted');
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      cancel();
      resolve('aborted');
    };
    const cancel = clock.setTimer(ms, () => {
      signal.removeEventListener('abort', onAbort);
      resolve('elapsed');
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
