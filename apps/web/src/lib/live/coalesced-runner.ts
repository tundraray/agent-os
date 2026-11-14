export type CoalescedRunner = {
  /**
   * Asks for a run. Idle and past the interval: starts now. Otherwise every request made meanwhile
   * shares exactly one next run. The promise settles with the run that covers this request, so a run's
   * rejection reaches each caller of that run.
   */
  request: () => Promise<void>;
  /** Drops the queued run (its callers resolve) and its timer; a run already started finishes. */
  cancel: () => void;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * One run at a time; requests during a run queue exactly one next run, and a run starts no sooner than
 * `minIntervalMs` after the previous one started (design-web.md, KD-2: re-reads by `tree` notes).
 */
export function createCoalescedRunner(
  run: () => Promise<void>,
  { minIntervalMs }: { minIntervalMs: number },
): CoalescedRunner {
  let running = false;
  let queued: Deferred | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStartAt = Number.NEGATIVE_INFINITY;

  const waitMs = (): number => lastStartAt + minIntervalMs - Date.now();

  function start(): Promise<void> {
    running = true;
    lastStartAt = Date.now();
    // A synchronous throw of `run` becomes a rejection, like an async failure.
    return new Promise<void>((resolve) => resolve(run())).finally(() => {
      running = false;
      if (queued !== null) schedule();
    });
  }

  function launchQueued(): void {
    timer = null;
    const next = queued;
    if (next === null) return;
    queued = null;
    start().then(next.resolve, next.reject);
  }

  function schedule(): void {
    if (timer !== null) return;
    const wait = waitMs();
    if (wait <= 0) launchQueued();
    else timer = setTimeout(launchQueued, wait);
  }

  return {
    request: () => {
      if (!running && queued === null && waitMs() <= 0) return start();
      if (queued === null) {
        queued = deferred();
        if (!running) schedule();
      }
      return queued.promise;
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queued?.resolve();
      queued = null;
    },
  };
}
