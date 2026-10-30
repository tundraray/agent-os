import { CHAT_PATH_PREFIX, threadPath } from "./route-thread-id";

export type UrlSyncInput = {
  /** Settled remote id of the active thread; undefined for a new, not yet created thread. */
  remoteId: string | undefined;
  location: Pick<Location, "pathname">;
  history: Pick<History, "replaceState">;
  router: { replace: (href: string) => void };
};

/**
 * Mirrors a runtime-initiated thread change into the URL (onThreadIdChange):
 * - a settled thread replaces the current entry with its path, so the first send from `/`
 *   does not leave an empty-chat entry behind;
 * - leaving a thread (e.g. the open thread was deleted) replaces `/chat/…` with `/`.
 */
export function syncUrlWithThread({ remoteId, location, history, router }: UrlSyncInput): void {
  if (remoteId !== undefined) {
    const path = threadPath(remoteId);
    if (location.pathname !== path) history.replaceState(null, "", path);
    return;
  }
  if (location.pathname.startsWith(CHAT_PATH_PREFIX)) router.replace("/");
}
