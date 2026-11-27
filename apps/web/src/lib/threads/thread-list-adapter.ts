import type { RemoteThreadListAdapter } from '@assistant-ui/react';
import type { ThreadListResponse, ThreadSummary } from '@agent-os/contracts';
import { logger } from '@/lib/logger';
import type { ThreadsApiClient } from './threads-api-client';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import type { ShellStatusStore } from './shell-status-store';
import { createTitlePollStream } from './title-poller';

// @assistant-ui/react re-exports the adapter type only; the metadata type is derived from it
// (@assistant-ui/core is a transitive dependency and is not imported directly).
type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter['fetch']>
>;

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

/** Only rows of `GET /api/threads` carry `state`; a single thread read has none and shows no mark. */
type ReadThread = ThreadSummary | ThreadListResponse['threads'][number];

const customOf = (thread: ReadThread) => ({
  forkable: thread.forkable,
  forked: thread.forkedFrom !== null,
  state: 'state' in thread ? thread.state : null,
});

const toRemoteMetadata = (thread: ReadThread): RemoteThreadMetadata => ({
  status: 'regular',
  remoteId: thread.id,
  title: thread.title ?? undefined,
  lastMessageAt: new Date(thread.updatedAt),
  custom: customOf(thread),
});

export type ThreadListAdapter = RemoteThreadListAdapter & {
  /**
   * The conversation was created for a first message the server did not accept: its coming delete is a
   * cleanup the employee did not ask for — no toast, a failure is only logged.
   */
  markEmpty: (remoteId: string) => void;
  /** The `custom` of a thread created in this tab: the library keeps only the remoteId of `initialize()`. */
  createdCustom: (remoteId: string) => ReturnType<typeof customOf> | undefined;
};

export function createThreadListAdapter({
  api,
  status,
  notify,
  feeds,
}: ThreadListAdapterDeps): ThreadListAdapter {
  const empty = new Set<string>();
  const created = new Map<string, ReturnType<typeof customOf>>();

  return {
    markEmpty: (remoteId) => void empty.add(remoteId),
    createdCustom: (remoteId) => created.get(remoteId),
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
        logger.error('[web-shell] thread list load failed', {
          nextPage: isNextPage,
          ...describeApiError(error),
        });
        if (isNextPage) status.getState().setLoadMoreFailed(true);
        throw error;
      }
    },
    async initialize() {
      const thread = await api.createThread();
      // A thread created in this tab has no stored history to load: mark it ready so the
      // main view never treats it as a route thread still waiting for history.
      status.getState().setHistory(thread.id, 'ready');
      created.set(thread.id, customOf(thread));
      return { remoteId: thread.id };
    },
    async fetch(threadId) {
      return toRemoteMetadata(await api.getThread(threadId));
    },
    async rename(remoteId, newTitle) {
      try {
        await api.renameThread({ threadId: remoteId, title: newTitle });
      } catch (error) {
        logger.error('[web-shell] thread rename failed', {
          remoteId,
          ...describeApiError(error),
        });
        notify.renameFailed();
        throw error;
      }
    },
    async delete(remoteId) {
      const cleanup = empty.delete(remoteId);
      try {
        await api.deleteThread(remoteId);
      } catch (error) {
        // 404: the thread is already gone (AC-16.3) — the user's intent is fulfilled.
        if (!(isApiRequestError(error) && error.kind === 'not_found')) {
          if (cleanup) {
            // The row stays in the list; the employee can delete it by hand.
            logger.warn('[web-shell] empty thread cleanup failed', {
              remoteId,
              ...describeApiError(error),
            });
          } else {
            logger.error('[web-shell] thread delete failed', {
              remoteId,
              ...describeApiError(error),
            });
            notify.deleteFailed();
          }
          throw error;
        }
      }
      feeds.forget(remoteId);
      status.getState().forgetThread(remoteId);
      if (cleanup)
        logger.info('[web-shell] empty thread cleanup done', {
          remoteId,
          outcome: 'deleted',
        });
      else notify.deleted();
    },
    archive: () => Promise.reject(new Error('Archive is not supported')),
    // The library asks once, right after `initialize()` and before any answer, which the poll closes at
    // once; the conversation's runtime asks again after the first model answer (spike S-1, c).
    async generateTitle(remoteId, messages) {
      return createTitlePollStream({
        remoteId,
        messages,
        deps: { api, status },
      });
    },
  };
}
