import { Logger } from '@nestjs/common';
import type { TranscriptRetention } from '@agent-os/engine';
import type { CancelTimer, Clock } from '@agent-os/runtime';

const RETENTION_VARIABLE = 'TRANSCRIPT_RETENTION_DAYS';
const DEFAULT_RETENTION_DAYS = 30;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Parses `TRANSCRIPT_RETENTION_DAYS` from `read` (design-self-check.md, Runtime settings): unset or empty gives 30
 * days; anything but a whole number of days not less than 1 throws naming the variable, which stops the start. The
 * server reads it for the purge and the self-check program for `show` over the main database.
 */
export function parseTranscriptRetention(
  read: (name: string) => string | undefined,
): { readonly days: number } {
  const value = read(RETENTION_VARIABLE);
  if (value === undefined || value === '') {
    return { days: DEFAULT_RETENTION_DAYS };
  }
  const days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(
      `${RETENTION_VARIABLE} must be a whole number of days not less than 1, got "${value}"`,
    );
  }
  return { days };
}

export interface TranscriptPurgeOptions {
  /** The runtime clock (`RUNTIME_CLOCK`): it arms the hourly timer. */
  readonly clock: Clock;
  /** The term from `parseTranscriptRetention`. */
  readonly retention: TranscriptRetention;
  /** `purgeExpiredTranscripts` over the main database; resolves to the number of transcripts deleted. */
  readonly purge: (retention: TranscriptRetention) => Promise<number>;
}

export interface TranscriptPurgeScheduler {
  /** Cancels the timer and waits for the purge in flight; call before the pool closes. */
  stop(): Promise<void>;
}

/**
 * Starts the purge of the server (design-self-check.md, C3 api): one pass at once, then one every hour, each calling
 * `purge` with the configured term — so a transcript is deleted no later than an hour after its term, however often
 * the server restarts. A failed pass is logged and the next hour tries again; after `stop` no pass starts.
 */
export function startTranscriptPurge(
  options: TranscriptPurgeOptions,
): TranscriptPurgeScheduler {
  const logger = new Logger('TranscriptPurge');
  let running = true;
  let cancelTimer: CancelTimer | null = null;
  let pass: Promise<void> = Promise.resolve();

  const purgeOnce = async (): Promise<void> => {
    try {
      const purged = await options.purge(options.retention);
      logger.log(`Expired transcripts purged count=${purged}`);
    } catch (error) {
      logger.error(
        'transcript purge failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  };

  const runPass = (): void => {
    cancelTimer = null;
    pass = purgeOnce().finally(() => {
      if (running) schedule();
    });
  };
  const schedule = (): void => {
    cancelTimer = options.clock.setTimer(PURGE_INTERVAL_MS, runPass);
  };

  runPass();
  return {
    async stop(): Promise<void> {
      running = false;
      cancelTimer?.();
      cancelTimer = null;
      await pass;
    },
  };
}
