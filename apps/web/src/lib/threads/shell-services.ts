import { createElement } from 'react';
import { AuiConfig } from '@assistant-ui/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { createAgentListStore, type AgentListStore } from '@/lib/agents/agent-list-store';
import { authApi } from '@/lib/auth/auth-api';
import { createCurrentUserStore, type CurrentUserStore } from '@/lib/auth/current-user';
import { createFeedStore, type FeedStore } from '@/lib/feed/feed-store';
import { createLeaveGuard, type LeaveGuard } from '@/lib/leave-guard';
import { createDraftHandoff, type DraftHandoff } from '@/lib/library/draft-handoff';
import { libraryApi } from '@/lib/library/library-api';
import { createLibraryIndex, type LibraryIndex } from '@/lib/library/library-index';
import { createAnnouncerStore, type AnnouncerStore } from '@/lib/live/announcer-store';
import { createLiveStore, type LiveStore, type OpenEventSource } from '@/lib/live/live-store';
import { logger } from '@/lib/logger';
import { createComposerSeed, type ComposerSeed } from './composer-seed';
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
  /** The signed-in employee, read once per shell mount by the user block. */
  currentUser: CurrentUserStore;
  /** The «Агенты» screen's store, one per shell; created on first read, so pages and expansion outlive a visit. */
  readonly agentList: AgentListStore;
  /** Live data of library records (KD-2); created on first read, so a visit without records reads nothing. */
  readonly libraryIndex: LibraryIndex;
  /** Chip and template text carried to a conversation's composer (KD-5). */
  composerSeed: ComposerSeed;
  /** A record draft carried from a conversation to the editor (KD-6). */
  draftHandoff: DraftHandoff;
  /** Unsaved changes on screen, asked about before every navigation (KD-4). */
  leaveGuard: LeaveGuard;
  listAdapter: ReturnType<typeof createThreadListAdapter>;
  auiConfig: AuiConfig;
  /** Loads `url` in the whole tab (a page outside the shell, an OAuth connect redirect). */
  navigate: (url: string) => void;
};

export type CreateShellServicesOptions = {
  /** Opens the live stream; a test passes its own source (jsdom has no `EventSource`). */
  openEventSource?: OpenEventSource;
  /** The page navigation «Выйти» and `navigate` use; a test passes its own (jsdom does not navigate). */
  location?: Pick<Location, 'assign'>;
};

type ThreadNoticeKey = keyof OperationNotifier;

/** A thread operation's notice, translated where the toast renders, so it follows the interface language (KD-5). */
function ThreadOperationNotice({ notice }: { notice: ThreadNoticeKey }) {
  return useTranslations('shell.thread')(notice);
}

const noticeOf = (notice: ThreadNoticeKey) => createElement(ThreadOperationNotice, { notice });

const notify: OperationNotifier = {
  renameFailed: () => {
    toast.error(noticeOf('renameFailed'));
  },
  deleted: () => {
    toast(noticeOf('deleted'));
  },
  deleteFailed: () => {
    toast.error(noticeOf('deleteFailed'));
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
          if (threadId === remoteId) void store.load();
        }),
        live.onReady(() => {
          if (watches(remoteId)) void store.load();
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
      // A conversation created in this tab (`initialize()` marked it ready) exists on the server only from its
      // first message: a read before that would be 404. The accepted send reads the feed.
      if (status.getState().history[remoteId] !== 'ready') void store.load();
      return store;
    },
    forget: (remoteId) => {
      feeds.get(remoteId)?.release();
      feeds.delete(remoteId);
    },
  };
}

/** Builds the shell's dependencies once per provider mount: wiring, no React state. */
export function createShellServices({ openEventSource, location }: CreateShellServicesOptions = {}): ShellServices {
  const apiClient = threadsApiClient;
  const currentUser = createCurrentUserStore({ read: authApi.me, endSession: authApi.signOut, location, logger });
  const status = createShellStatusStore();
  const announcer = createAnnouncerStore();
  const live = createLiveStore({ openEventSource, announcer, logger });
  const feeds = createThreadFeeds({ api: apiClient, status, live, announcer });
  const listAdapter = createThreadListAdapter({ api: apiClient, status, notify, feeds });
  let agentList: AgentListStore | undefined;
  let libraryIndex: LibraryIndex | undefined;

  return {
    apiClient,
    status,
    live,
    announcer,
    feeds,
    currentUser,
    get agentList() {
      agentList ??= createAgentListStore({ api: apiClient, live, logger });
      return agentList;
    },
    get libraryIndex() {
      libraryIndex ??= createLibraryIndex({ read: libraryApi.list, logger });
      return libraryIndex;
    },
    composerSeed: createComposerSeed(),
    draftHandoff: createDraftHandoff(),
    leaveGuard: createLeaveGuard(),
    listAdapter,
    auiConfig: AuiConfig({}),
    // `window` is read at the call: the services are also built during server rendering.
    navigate: (url) => (location ?? window.location).assign(url),
  };
}
