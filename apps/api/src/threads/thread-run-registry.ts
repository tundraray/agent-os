import { Inject, Injectable, Logger } from '@nestjs/common';

/** Token of the time a delete waits for the thread's runs to settle, in ms; `ThreadsModule` provides 5 000. */
export const THREAD_RUN_SETTLE_TIMEOUT_MS = Symbol(
  'THREAD_RUN_SETTLE_TIMEOUT_MS',
);

/** One registered chat run of a thread. */
export interface ThreadRunHandle {
  /** The run's abort signal; already aborted when the thread is being deleted. */
  readonly signal: AbortSignal;
  /** Cancels the run (the client closed the connection). */
  abort(): void;
  /** The run is over: Mastra has finished saving it. Idempotent. */
  release(): void;
}

type Run = {
  controller: AbortController;
  /** Resolves on the first `release()`. */
  released: Promise<void>;
  isReleased: boolean;
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'Unknown';

/**
 * Knows the chat runs in flight in this process per `threadId` and lets a
 * delete cancel them, wait until Mastra has saved them, and only then delete
 * the thread — the end-of-run save would otherwise re-create a deleted thread
 * (KD-6, AC-16.1 (b)). Process-local: runs of another API instance are not seen.
 */
@Injectable()
export class ThreadRunRegistry {
  private readonly logger = new Logger(ThreadRunRegistry.name);
  /** Runs in flight per thread; an entry is removed with its last run. */
  private readonly runs = new Map<string, Set<Run>>();
  /** Deletes in progress per thread; an entry is removed when the last one ends. */
  private readonly deleting = new Map<string, number>();

  constructor(
    @Inject(THREAD_RUN_SETTLE_TIMEOUT_MS)
    private readonly settleTimeoutMs: number,
  ) {}

  register(threadId: string): ThreadRunHandle {
    const controller = new AbortController();
    let markReleased: () => void = () => undefined;
    const run: Run = {
      controller,
      released: new Promise<void>((resolve) => {
        markReleased = resolve;
      }),
      isReleased: false,
    };
    if (this.deleting.has(threadId)) controller.abort();
    const threadRuns = this.runs.get(threadId) ?? new Set<Run>();
    threadRuns.add(run);
    this.runs.set(threadId, threadRuns);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      release: () => {
        if (run.isReleased) return;
        run.isReleased = true;
        threadRuns.delete(run);
        if (threadRuns.size === 0 && this.runs.get(threadId) === threadRuns) {
          this.runs.delete(threadId);
        }
        markReleased();
      },
    };
  }

  /**
   * Marks the thread as being deleted, aborts its runs, waits for their
   * `release()` (at most `THREAD_RUN_SETTLE_TIMEOUT_MS`), then runs `action`;
   * its error is rethrown. On the timeout, `action` runs again after the
   * release of each remaining run (errors logged, not rethrown).
   */
  async cancelRunsThen(
    threadId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    this.deleting.set(threadId, (this.deleting.get(threadId) ?? 0) + 1);
    const pending = [...(this.runs.get(threadId) ?? [])];
    for (const run of pending) run.controller.abort();
    const settled = await this.waitForRelease(pending);
    try {
      await action();
    } catch (error) {
      this.endDelete(threadId);
      throw error;
    }
    if (settled) {
      this.endDelete(threadId);
      return;
    }
    this.logger.warn(`Run outlived thread delete thread=${threadId}`);
    const remaining = pending.filter((run) => !run.isReleased);
    void this.deleteAgainAfter(threadId, remaining, action);
  }

  /** Whether every run released within the settle timeout. */
  private async waitForRelease(runs: Run[]): Promise<boolean> {
    if (runs.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.settleTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.all(runs.map((run) => run.released)).then(() => true),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Repeats `action` after each remaining run is released; the delete ends after the last repeat. */
  private async deleteAgainAfter(
    threadId: string,
    remaining: Run[],
    action: () => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      remaining.map(async (run) => {
        await run.released;
        try {
          await action();
        } catch (error) {
          this.logger.warn(
            `Thread re-delete failed thread=${threadId} reason=${errorName(error)}`,
          );
        }
      }),
    );
    this.endDelete(threadId);
  }

  private endDelete(threadId: string): void {
    const count = (this.deleting.get(threadId) ?? 1) - 1;
    if (count > 0) this.deleting.set(threadId, count);
    else this.deleting.delete(threadId);
  }
}
