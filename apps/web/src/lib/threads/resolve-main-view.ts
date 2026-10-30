import type { HistoryStatus } from './shell-status-store';
import { isThreadsApiError } from './threads-api-error';

export type { HistoryStatus };

export type MainViewInput = {
  /** Thread id from the URL; undefined on `/`. */
  routeThreadId: string | undefined;
  /** Remote id of the thread the runtime has open; undefined until the runtime resolves one. */
  mainRemoteId: string | undefined;
  /** `threads.switchError` of the runtime: the last failed switch. */
  switchError: { threadId: string; error: unknown } | undefined;
  /** ShellStatus history status of the open thread. */
  historyStatus: HistoryStatus | undefined;
};

export type MainView =
  | { kind: 'thread'; deleted: boolean }
  | { kind: 'switching' }
  | { kind: 'not-found' }
  | { kind: 'load-error'; retry: 'switch' | 'history' };

/** Decides what the main area shows: the feed (TH-01..05), its skeleton while switching, TH-06 or TH-07. */
export function resolveMainView({ routeThreadId, mainRemoteId, switchError, historyStatus }: MainViewInput): MainView {
  if (switchError !== undefined && switchError.threadId === routeThreadId) {
    const notFound = isThreadsApiError(switchError.error) && switchError.error.kind === 'not_found';
    return notFound ? { kind: 'not-found' } : { kind: 'load-error', retry: 'switch' };
  }
  // A direct link or a click: the runtime has not opened the URL thread yet — skeleton, never the welcome.
  if (routeThreadId !== undefined && mainRemoteId !== routeThreadId) return { kind: 'switching' };
  if (historyStatus === 'not_found') return { kind: 'not-found' };
  if (historyStatus === 'load_failed') return { kind: 'load-error', retry: 'history' };
  // F5 on /chat/<id>: the history load has not started (undefined) or is running; a thread created in this tab is already 'ready'.
  if (routeThreadId !== undefined && (historyStatus === undefined || historyStatus === 'loading')) {
    return { kind: 'switching' };
  }
  return { kind: 'thread', deleted: historyStatus === 'deleted' };
}
