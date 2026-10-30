import { createStore, type StoreApi } from "zustand/vanilla";

export type HistoryStatus = "loading" | "ready" | "not_found" | "load_failed" | "deleted";

/**
 * Shell facts the assistant-ui runtime does not keep (or swallows). The store never mirrors
 * runtime data: thread list, titles, messages, isRunning and the current thread live there.
 */
export type ShellStatusState = {
  /** History load status per thread body, keyed by remoteId. */
  history: Readonly<Record<string, HistoryStatus>>;
  /** The last `list({ after })` call failed. */
  loadMoreFailed: boolean;
  /** A title poll is running for the thread, keyed by remoteId. */
  titleWaiting: Readonly<Record<string, true>>;
  /** Local activity time (ms since epoch) of a thread list item, keyed by item id. */
  activityAt: Readonly<Record<string, number>>;
  setHistory: (remoteId: string, status: HistoryStatus) => void;
  setLoadMoreFailed: (failed: boolean) => void;
  setTitleWaiting: (remoteId: string, waiting: boolean) => void;
  bumpActivity: (itemId: string, at: number) => void;
  forgetThread: (remoteId: string) => void;
};

export type ShellStatusStore = StoreApi<ShellStatusState>;

const without = <T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

export function createShellStatusStore(): ShellStatusStore {
  return createStore<ShellStatusState>()((set) => ({
    history: {},
    loadMoreFailed: false,
    titleWaiting: {},
    activityAt: {},
    setHistory: (remoteId, status) =>
      set((state) =>
        state.history[remoteId] === status
          ? state
          : { history: { ...state.history, [remoteId]: status } },
      ),
    setLoadMoreFailed: (failed) =>
      set((state) => (state.loadMoreFailed === failed ? state : { loadMoreFailed: failed })),
    setTitleWaiting: (remoteId, waiting) =>
      set((state) => {
        if ((state.titleWaiting[remoteId] === true) === waiting) return state;
        return {
          titleWaiting: waiting
            ? { ...state.titleWaiting, [remoteId]: true }
            : without(state.titleWaiting, remoteId),
        };
      }),
    bumpActivity: (itemId, at) =>
      set((state) => ({ activityAt: { ...state.activityAt, [itemId]: at } })),
    // Items loaded from the list use remoteId as their id, so activityAt is cleared by the same key.
    forgetThread: (remoteId) =>
      set((state) => ({
        history: without(state.history, remoteId),
        titleWaiting: without(state.titleWaiting, remoteId),
        activityAt: without(state.activityAt, remoteId),
      })),
  }));
}
