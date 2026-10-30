import { ThreadsApiError } from "./threads-api-error";

export type RetryGate = {
  /** Parks a failed history load until the user retries or the thread is deleted. */
  wait: (remoteId: string) => Promise<void>;
  /** «Повторить»: resolves the parked waiter; the load loop runs again. */
  release: (remoteId: string) => void;
  /** Thread deleted: rejects the parked waiter with ThreadsApiError('not_found'). */
  drop: (remoteId: string) => void;
};

type Waiter = { resolve: () => void; reject: (error: ThreadsApiError) => void };

// Invariant: at most one waiter per remoteId — one mounted thread body per thread, and
// useExternalHistory calls load() once per mount. release/drop without a waiter are no-ops.
export function createRetryGate(): RetryGate {
  const waiters = new Map<string, Waiter>();
  const take = (remoteId: string): Waiter | undefined => {
    const waiter = waiters.get(remoteId);
    waiters.delete(remoteId);
    return waiter;
  };
  return {
    wait: (remoteId) =>
      new Promise<void>((resolve, reject) => {
        waiters.set(remoteId, { resolve, reject });
      }),
    release: (remoteId) => take(remoteId)?.resolve(),
    drop: (remoteId) => take(remoteId)?.reject(new ThreadsApiError("not_found")),
  };
}
