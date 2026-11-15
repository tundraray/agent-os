import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ThreadSummary } from "@agent-os/contracts";
import { logger } from "@/lib/logger";
import type { ThreadsApiClient } from "./threads-api-client";
import { describeThreadsError, isThreadsApiError } from "./threads-api-error";
import type { ShellStatusStore } from "./shell-status-store";
import { createTitlePollStream } from "./title-poller";

// @assistant-ui/react re-exports the adapter type only; the metadata type is derived from it
// (@assistant-ui/core is a transitive dependency and is not imported directly).
type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;

export type OperationNotifier = {
  renameFailed: () => void;
  deleted: () => void;
  deleteFailed: () => void;
};

export type ThreadListAdapterDeps = {
  api: ThreadsApiClient;
  status: ShellStatusStore;
  notify: OperationNotifier;
  /** The conversations' feed stores: a deleted conversation's store is dropped. */
  feeds: { forget: (remoteId: string) => void };
};

const toRemoteMetadata = (thread: ThreadSummary): RemoteThreadMetadata => ({
  status: "regular",
  remoteId: thread.id,
  title: thread.title ?? undefined,
  lastMessageAt: new Date(thread.updatedAt),
});

export function createThreadListAdapter({
  api,
  status,
  notify,
  feeds,
}: ThreadListAdapterDeps): RemoteThreadListAdapter {
  return {
    async list(params) {
      const isNextPage = params?.after !== undefined;
      try {
        const page = await api.listThreads(params?.after);
        if (isNextPage) status.getState().setLoadMoreFailed(false);
        return {
          threads: page.threads.map(toRemoteMetadata),
          nextCursor: page.nextCursor ?? undefined,
        };
      } catch (error) {
        logger.error("[web-shell] thread list load failed", {
          nextPage: isNextPage,
          ...describeThreadsError(error),
        });
        if (isNextPage) status.getState().setLoadMoreFailed(true);
        throw error;
      }
    },
    async initialize() {
      const thread = await api.createThread();
      // A thread created in this tab has no stored history to load: mark it ready so the
      // main view never treats it as a route thread still waiting for history.
      status.getState().setHistory(thread.id, "ready");
      return { remoteId: thread.id };
    },
    async fetch(threadId) {
      return toRemoteMetadata(await api.getThread(threadId));
    },
    async rename(remoteId, newTitle) {
      try {
        await api.renameThread({ threadId: remoteId, title: newTitle });
      } catch (error) {
        logger.error("[web-shell] thread rename failed", {
          remoteId,
          ...describeThreadsError(error),
        });
        notify.renameFailed();
        throw error;
      }
    },
    async delete(remoteId) {
      try {
        await api.deleteThread(remoteId);
      } catch (error) {
        // 404: the thread is already gone (AC-16.3) — the user's intent is fulfilled.
        if (!(isThreadsApiError(error) && error.kind === "not_found")) {
          logger.error("[web-shell] thread delete failed", {
            remoteId,
            ...describeThreadsError(error),
          });
          notify.deleteFailed();
          throw error;
        }
      }
      feeds.forget(remoteId);
      status.getState().forgetThread(remoteId);
      notify.deleted();
    },
    archive: () => Promise.reject(new Error("Archive is not supported")),
    // The library asks once, right after `initialize()` and before any answer, which the poll closes at
    // once; the conversation's runtime asks again after the first model answer (spike S-1, c).
    async generateTitle(remoteId, messages) {
      return createTitlePollStream({ remoteId, messages, deps: { api, status } });
    },
  };
}
