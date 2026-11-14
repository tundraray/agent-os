import { AuiConfig } from '@assistant-ui/react';
import { toast } from 'sonner';
import { createAgentListStore, type AgentListStore } from '@/lib/agents/agent-list-store';
import { createFeedStore, type FeedStore } from '@/lib/feed/feed-store';
import { createAnnouncerStore, type AnnouncerStore } from '@/lib/live/announcer-store';
import { createLiveStore, type LiveStore, type OpenEventSource } from '@/lib/live/live-store';
import { logger } from '@/lib/logger';
import { createShellStatusStore, type ShellStatusStore } from './shell-status-store';
import { createThreadListAdapter, type OperationNotifier } from './thread-list-adapter';
import { threadsApiClient, type ThreadsApiClient } from './threads-api-client';

/** One feed store per conversation opened in this tab. */
export type ThreadFeeds = {
  /**
   * The conversation's store, created and loaded on first use. `itemId` is the thread list item the
   * store lifts in the list when a message is accepted; it defaults to `remoteId`, which is the id of
   * every item loaded from the list.
   */
  forThread: (remoteId: string, itemId?: string) => FeedStore;
  /** The conversation was deleted: its store stops reading and is dropped. */
  forget: (remoteId: string) => void;
};

export type ShellServices = {
  apiClient: ThreadsApiClient;
  status: ShellStatusStore;
  live: LiveStore;
  announcer: AnnouncerStore;
  feeds: ThreadFeeds;
  /** The «Агенты» screen's store, one per shell; created on first read, so pages and expansion outlive a visit. */
  readonly agentList: AgentListStore;
  listAdapter: ReturnType<typeof createThreadListAdapter>;
  auiConfig: AuiConfig;
};

export type CreateShellServicesOptions = {
  /** Opens the live stream; a test passes its own source (jsdom has no `EventSource`). */
  openEventSource?: OpenEventSource;
};

const notify: OperationNotifier = {
  renameFailed: () => {
    toast.error('Не удалось переименовать беседу. Попробуйте ещё раз.');
  },
  deleted: () => {
    toast('Беседа удалена');
  },
  deleteFailed: () => {
    toast.error('Не удалось удалить беседу. Попробуйте ещё раз.');
  },
};

type ThreadFeedsDeps = {
  api: ThreadsApiClient;
  status: ShellStatusStore;
  live: LiveStore;
  announcer: AnnouncerStore;
};

/**
 * Each store follows the live stream (design-web.md, KD-2): a `tree` note with its own `threadId`
 * re-reads it; `ready` and the answer's text parts reach it only while the stream watches it,
 * because a `thread:` stream carries the parts of that conversation's root alone.
 */
function createThreadFeeds({ api, status, live, announcer }: ThreadFeedsDeps): ThreadFeeds {
  const feeds = new Map<string, { store: FeedStore; release: () => void }>();
  const watches = (remoteId: string): boolean => live.getState().target === `thread:${remoteId}`;

  return {
    forThread: (remoteId, itemId = remoteId) => {
      const known = feeds.get(remoteId);
      if (known !== undefined) return known.store;
      const store = createFeedStore({
        source: { kind: 'thread', threadId: remoteId },
        api,
        status,
        announcer,
        logger,
        onActivity: () => status.getState().bumpActivity(itemId, Date.now()),
      });
      const unsubscribers = [
        live.onTree((threadId) => {
          if (threadId === remoteId) void store.refresh();
        }),
        live.onReady(() => {
          if (watches(remoteId)) void store.refresh();
        }),
        live.onDelta((delta) => {
          if (watches(remoteId)) store.applyDelta(delta);
        }),
      ];
      feeds.set(remoteId, {
        store,
        release: () => {
          for (const unsubscribe of unsubscribers) unsubscribe();
          store.dispose();
        },
      });
      void store.load();
      return store;
    },
    forget: (remoteId) => {
      feeds.get(remoteId)?.release();
      feeds.delete(remoteId);
    },
  };
}

/** Builds the shell's dependencies once per provider mount. Pure wiring, no React. */
export function createShellServices({ openEventSource }: CreateShellServicesOptions = {}): ShellServices {
  const apiClient = threadsApiClient;
  const status = createShellStatusStore();
  const announcer = createAnnouncerStore();
  const live = createLiveStore({ openEventSource, announcer, logger });
  const feeds = createThreadFeeds({ api: apiClient, status, live, announcer });
  const listAdapter = createThreadListAdapter({ api: apiClient, status, notify, feeds });
  let agentList: AgentListStore | undefined;

  return {
    apiClient,
    status,
    live,
    announcer,
    feeds,
    get agentList() {
      agentList ??= createAgentListStore({ api: apiClient, live, logger });
      return agentList;
    },
    listAdapter,
    auiConfig: AuiConfig({}),
  };
}
