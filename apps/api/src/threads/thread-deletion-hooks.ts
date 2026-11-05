import { Injectable } from '@nestjs/common';

/** The thread being deleted, after the ownership check. */
export interface ThreadRef {
  threadId: string;
  resourceId: string;
}

/** What `stop` hands back once its own work is committed. */
export interface ThreadDeletionStop {
  /**
   * Resolves when the hook's local work has stopped or the window has run out; never rejects.
   */
  settled: Promise<void>;
}

/**
 * Data of another module tied to a thread, removed with it (design-runtime.md,
 * ThreadDeletionHook). Both methods are idempotent: a failed delete is repeated whole.
 */
export interface ThreadDeletionHook {
  /**
   * Called before the thread's chat runs are cancelled, outside the thread's lock: stops the
   * thread's work and returns at once. An error aborts the delete (500), nothing is deleted.
   * `window` aborts when the delete's settle window ends.
   */
  stop(ref: ThreadRef, window: AbortSignal): Promise<ThreadDeletionStop>;
  /**
   * Called under the thread's `ThreadWriteLock`, right before the thread is deleted: removes the
   * thread's data. An error keeps the thread (500); the retry deletes both.
   */
  purge(ref: ThreadRef): Promise<void>;
}

/**
 * Hooks "before a thread is deleted", registered by other modules at start (`onModuleInit`), so
 * `threads` depends on none of them (KD-5). Hooks run in registration order; the first error is
 * rethrown and the remaining hooks are not called.
 */
@Injectable()
export class ThreadDeletionHooks {
  private readonly hooks: ThreadDeletionHook[] = [];

  register(hook: ThreadDeletionHook): void {
    this.hooks.push(hook);
  }

  /** `stop` of every hook; `settled` resolves when all of theirs have. */
  async stopAll(
    ref: ThreadRef,
    window: AbortSignal,
  ): Promise<ThreadDeletionStop> {
    const settled: Promise<void>[] = [];
    for (const hook of this.hooks) {
      settled.push((await hook.stop(ref, window)).settled);
    }
    return { settled: Promise.all(settled).then(() => undefined) };
  }

  async purgeAll(ref: ThreadRef): Promise<void> {
    for (const hook of this.hooks) await hook.purge(ref);
  }
}
