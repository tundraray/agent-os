/**
 * Ports through which the runtime reaches what it does not own (ADR-0004): the composition root
 * (`apps/api`) binds them; the runtime knows nothing about threads or the logging framework.
 */

/**
 * Ownership check of the thread an investigation belongs to. `apps/api` passes `ThreadsService`.
 */
export interface ThreadOwnership {
  /**
   * Runs `fn` under the thread's lock once the thread is found to belong to `resourceId`, and
   * returns its result. A thread that is missing or not the owner's → the implementation's error,
   * propagated unchanged.
   */
  withOwnedThread<T>(
    threadId: string,
    resourceId: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

/** The thread being deleted, after the ownership check (the runtime's own reference type). */
export interface ThreadRef {
  threadId: string;
  resourceId: string;
}

/** What `InvestigationService.stopThread` hands back once its own work is committed. */
export interface ThreadDeletionStop {
  /**
   * Resolves when the thread's attempts have stopped or the window has run out; never rejects.
   */
  settled: Promise<void>;
}

/** Correlation fields of a runtime log line (design-runtime.md, Logging and Monitoring). */
export interface RuntimeLogFields {
  investigationId?: string;
  taskId?: string;
  attempt?: number;
  eventId?: string;
  consumer?: string;
}

/**
 * Logger of the runtime. `warn`: `fenced`, recovery, shutdown timeout; `error`:
 * `needs_attention`, a handler's exception, a failed outcome commit. Lines carry no task input,
 * evidence content or tool arguments. `apps/api` passes an adapter over the Nest `Logger`.
 */
export interface RuntimeLogger {
  log(message: string, fields?: RuntimeLogFields): void;
  warn(message: string, fields?: RuntimeLogFields): void;
  error(message: string, fields?: RuntimeLogFields): void;
}
