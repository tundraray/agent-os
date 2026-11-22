import type { Logger } from '@agent-os/common';
import type { CancelTimer, Clock } from '../clock';

/** Backoff of a loop doubles from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`. */
const MAX_BACKOFF_DOUBLINGS = 4;

/** Delay after the `failures`-th consecutive failure of a loop (1-based). */
export const backoffDelay = (pollMs: number, failures: number): number =>
  pollMs * 2 ** Math.min(Math.max(failures - 1, 0), MAX_BACKOFF_DOUBLINGS);

export interface WorkerLoopOptions {
  /** Name in the log. */
  name: string;
  /** Delay after a pass that left no work behind. */
  periodMs: number;
  /** `RUNTIME_POLL_MS`: the first delay after a failed pass. */
  pollMs: number;
  clock: Clock;
  logger: Logger;
  /** One pass; resolves `true` when work may remain, and the next pass runs at once. */
  pass: () => Promise<boolean>;
}

/**
 * A periodic worker of the runtime (relay, sweeper). A failed pass — the database is unreachable —
 * is logged and retried with backoff doubling from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`;
 * the state is not changed.
 */
export class WorkerLoop {
  private running = false;
  private failures = 0;
  private cancelTimer: CancelTimer | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: WorkerLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Stops scheduling passes and waits for the pass in flight. */
  async stop(): Promise<void> {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer = this.options.clock.setTimer(delayMs, () => {
      this.cancelTimer = undefined;
      this.inFlight = this.run().finally(() => {
        this.inFlight = undefined;
      });
    });
  }

  private async run(): Promise<void> {
    const { name, periodMs, pollMs, logger, pass } = this.options;
    let delay = periodMs;
    try {
      const more = await pass();
      this.failures = 0;
      if (more) delay = 0;
    } catch (error) {
      this.failures += 1;
      delay = backoffDelay(pollMs, this.failures);
      logger.error('worker pass failed', { worker: name, error, retryInMs: delay });
    }
    if (this.running) this.schedule(delay);
  }
}
