import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { chatThreadRuns, type Database } from '@agent-os/db';
import { and, eq, gt, lte } from 'drizzle-orm';

/** Token of the time a delete waits for the thread's runs to settle, in ms; `ThreadsModule` provides 5 000. */
export const THREAD_RUN_SETTLE_TIMEOUT_MS = Symbol(
  'THREAD_RUN_SETTLE_TIMEOUT_MS',
);

/** Token of the {@link ThreadRunMarks} of the registry; `ThreadsModule` provides them over `app.chat_thread_runs`. */
export const THREAD_RUN_MARKS = Symbol('THREAD_RUN_MARKS');

/** How long a run mark counts after its last write (design-lifecycle.md, Runtime settings: 30 s). */
const RUN_MARK_LEASE_MS = 30_000;

/** How often a run in flight extends its mark (design-lifecycle.md, Runtime settings: every 10 s). */
const RUN_MARK_RENEW_MS = 10_000;

/** One row of `app.chat_thread_runs`: a chat run in flight of some instance and the end of its lease. */
export interface RunMark {
  readonly runId: string;
  readonly threadId: string;
  readonly leaseExpiresAt: Date;
}

/** The run marks shared by every API instance (KD-6): the port the registry writes and reads them through. */
export interface ThreadRunMarks {
  /** Inserts `mark` and, in the same transaction, deletes every mark whose lease ended at or before `now`. */
  insert(mark: RunMark, now: Date): Promise<void>;
  /** Moves the lease of the run's mark; a mark already deleted stays deleted. */
  renew(runId: string, leaseExpiresAt: Date): Promise<void>;
  remove(runId: string): Promise<void>;
  /** Whether the thread has a mark whose lease ends after `now`. */
  hasLive(threadId: string, now: Date): Promise<boolean>;
}

/** The time of the run marks: `RUNTIME_CLOCK`, so a test crosses a lease by moving the clock. */
export interface ThreadRunClock {
  now(): Date;
  /** Runs `callback` once after `ms`; returns the cancel. */
  setTimer(ms: number, callback: () => void): () => void;
}

export interface ThreadRunRegistryOptions {
  /** `THREAD_RUN_SETTLE_TIMEOUT_MS`. */
  readonly settleTimeoutMs: number;
  readonly marks: ThreadRunMarks;
  readonly clock: ThreadRunClock;
}

/** {@link ThreadRunMarks} over `app.chat_thread_runs` of the database `db` returns when a mark is written or read. */
export function postgresThreadRunMarks(db: () => Database): ThreadRunMarks {
  return {
    insert: (mark, now) =>
      db().transaction(async (tx) => {
        await tx
          .delete(chatThreadRuns)
          .where(lte(chatThreadRuns.leaseExpiresAt, now));
        await tx.insert(chatThreadRuns).values(mark);
      }),
    renew: async (runId, leaseExpiresAt) => {
      await db()
        .update(chatThreadRuns)
        .set({ leaseExpiresAt })
        .where(eq(chatThreadRuns.runId, runId));
    },
    remove: async (runId) => {
      await db().delete(chatThreadRuns).where(eq(chatThreadRuns.runId, runId));
    },
    hasLive: async (threadId, now) => {
      const [row] = await db()
        .select({ runId: chatThreadRuns.runId })
        .from(chatThreadRuns)
        .where(
          and(
            eq(chatThreadRuns.threadId, threadId),
            gt(chatThreadRuns.leaseExpiresAt, now),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}

/** One registered chat run of a thread. */
export interface ThreadRunHandle {
  /** The run's abort signal; already aborted when the thread is being deleted. */
  readonly signal: AbortSignal;
  /** Cancels the run (the client closed the connection). */
  abort(): void;
  /**
   * Writes the run's mark and starts its renewal: called once the thread's ownership check has passed and before
   * anything streams, so a request for a made-up or foreign thread writes no row. When the mark is not written, the run
   * is released and the error is rethrown: the chat answers it as a database failure.
   */
  mark(): Promise<void>;
  /** The run is over: Mastra has finished saving it. Deletes its mark in the background. Idempotent. */
  release(): void;
}

/** A local run without its mark: what `registerLocal` returns. */
type LocalRunHandle = Omit<ThreadRunHandle, 'mark'>;

type Run = {
  controller: AbortController;
  /** Resolves on the first `release()`. */
  released: Promise<void>;
  isReleased: boolean;
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'Unknown';

/**
 * Knows the chat runs of a thread. Every instance sees them through the run marks (KD-6): the handle's `mark` writes
 * a mark with a 30 s lease and extends it every 10 s while the run goes on, `release` deletes it, and `hasRuns` reads
 * the live marks of any instance; a mark of a crashed instance counts until its lease ends and is deleted by the next
 * mark write. A delete cancels the thread's runs, waits until Mastra has saved them, and only then deletes the
 * thread — the end-of-run save would otherwise re-create a deleted thread (AC-16.1 (b)); that part is process-local:
 * runs of another API instance are not cancelled.
 */
export class ThreadRunRegistry {
  private readonly logger = new Logger(ThreadRunRegistry.name);
  /** Runs in flight per thread; an entry is removed with its last run. */
  private readonly runs = new Map<string, Set<Run>>();
  /** Deletes in progress per thread; an entry is removed when the last one ends. */
  private readonly deleting = new Map<string, number>();
  private readonly settleTimeoutMs: number;
  private readonly marks: ThreadRunMarks;
  private readonly clock: ThreadRunClock;

  constructor(options: ThreadRunRegistryOptions) {
    this.settleTimeoutMs = options.settleTimeoutMs;
    this.marks = options.marks;
    this.clock = options.clock;
  }

  /**
   * Registers the run in this process at once (a delete started from now on sees it) and writes nothing: the handle's
   * `mark` writes the run's mark once the thread's ownership check has passed.
   */
  register(threadId: string): ThreadRunHandle {
    const local = this.registerLocal(threadId);
    let marked: { runId: string; stopRenewal: () => void } | null = null;
    let released = false;
    const removeMark = (runId: string) => {
      void this.marks
        .remove(runId)
        .catch((error: unknown) =>
          this.logger.warn(
            `Run mark not removed thread=${threadId} reason=${errorName(error)}`,
          ),
        );
    };
    const release = () => {
      if (released) return;
      released = true;
      local.release();
      if (marked === null) return;
      marked.stopRenewal();
      removeMark(marked.runId);
    };
    return {
      signal: local.signal,
      abort: () => local.abort(),
      mark: async () => {
        const runId = randomUUID();
        try {
          const now = this.clock.now();
          await this.marks.insert(
            { runId, threadId, leaseExpiresAt: this.leaseFrom(now) },
            now,
          );
        } catch (error) {
          release();
          throw error;
        }
        // Released while the insert was in flight: the mark must not outlive the run.
        if (released) return removeMark(runId);
        marked = { runId, stopRenewal: this.renewEvery(runId, threadId) };
      },
      release,
    };
  }

  /** Whether the thread has a chat run in flight on any instance: a mark whose lease has not ended. */
  hasRuns(threadId: string): Promise<boolean> {
    return this.marks.hasLive(threadId, this.clock.now());
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

  /** The run in this process's memory: what a delete of the thread cancels and waits for. */
  private registerLocal(threadId: string): LocalRunHandle {
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

  private leaseFrom(now: Date): Date {
    return new Date(now.getTime() + RUN_MARK_LEASE_MS);
  }

  /**
   * Extends the run's mark every {@link RUN_MARK_RENEW_MS} until the returned stop is called. A failed renewal is
   * logged and tried again on the next pulse; if the lease ends meanwhile, the mark stops counting.
   */
  private renewEvery(runId: string, threadId: string): () => void {
    let cancelTimer: (() => void) | null = null;
    let stopped = false;
    const pulse = () => {
      cancelTimer = this.clock.setTimer(RUN_MARK_RENEW_MS, () => {
        void this.marks
          .renew(runId, this.leaseFrom(this.clock.now()))
          .catch((error: unknown) =>
            this.logger.warn(
              `Run mark not renewed thread=${threadId} reason=${errorName(error)}`,
            ),
          )
          .finally(() => {
            if (!stopped) pulse();
          });
      });
    };
    pulse();
    return () => {
      stopped = true;
      cancelTimer?.();
    };
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
