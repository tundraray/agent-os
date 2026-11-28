import { createElement } from 'react';
import { AuiConfig } from '@assistant-ui/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  createAgentListStore,
  type AgentListStore,
} from '@/lib/agents/agent-list-store';
import { authApi } from '@/lib/auth/auth-api';
import {
  createCurrentUserStore,
  type CurrentUserStore,
} from '@/lib/auth/current-user';
import { createFeedStore, type FeedStore } from '@/lib/feed/feed-store';
import { createLeaveGuard, type LeaveGuard } from '@/lib/leave-guard';
import {
  createCreatedHandoff,
  type CreatedHandoff,
} from '@/lib/library/created-handoff';
import { libraryApi } from '@/lib/library/library-api';
import {
  createLibraryIndex,
  type LibraryIndex,
} from '@/lib/library/library-index';
import {
  createAnnouncerStore,
  type AnnouncerStore,
} from '@/lib/live/announcer-store';
import {
  createLiveStore,
  type LiveStore,
  type OpenEventSource,
} from '@/lib/live/live-store';
import { logger } from '@/lib/logger';
import {
  createNotificationsStore,
  type NotificationsStore,
} from '@/lib/notifications/notifications-store';
import { createSearchStore, type SearchStore } from '@/lib/search/search-store';
import {
  createWorkspaceStore,
  type WorkspaceStore,
} from '@/lib/shell/workspace-store';
import { createComposerSeed, type ComposerSeed } from './composer-seed';
import {
  createShellStatusStore,
  type ShellStatusStore,
} from './shell-status-store';
import {
  createThreadListAdapter,
  type OperationNotifier,
} from './thread-list-adapter';
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
  /** Browser notification permission and the offer LF-03 (live-feed KD-5). */
  notifications: NotificationsStore;
  /** The «Агенты» screen's store, one per shell; created on first read, so pages and expansion outlive a visit. */
  readonly agentList: AgentListStore;
  /** Live data of library records (KD-2); created on first read, so a visit without records reads nothing. */
  readonly libraryIndex: LibraryIndex;
  /** The conversation search (conversation-search KD-7); created on first read, outlives navigation and the drawer. */
  readonly search: SearchStore;
  /** Chip and template text carried to a conversation's composer (KD-5). */
  composerSeed: ComposerSeed;
  /** The editor page of a record just created (KD-6). */
  createdHandoff: CreatedHandoff;
  /** Unsaved changes on screen, asked about before every navigation (KD-4). */
  leaveGuard: LeaveGuard;
  /** Whether the diagram panel is open and on which tab (deep-agents KD-6). */
  workspace: WorkspaceStore;
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

const noticeOf = (notice: ThreadNoticeKey) =>
  createElement(ThreadOperationNotice, { notice });

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
  notifications: NotificationsStore;
};

/**
 * Each store follows the live stream (design-web.md, KD-2; live-feed design-web.md, KD-1): its root agent's records,
 * its state and its row re-read it, its deletion marks it deleted without a read; `ready` and the answer's text parts reach it only while the stream watches it,
 * because a `thread:` stream carries the parts of that conversation's root alone.
 */
function createThreadFeeds({
  api,
  status,
  live,
  announcer,
  notifications,
}: ThreadFeedsDeps): ThreadFeeds {
  const feeds = new Map<string, { store: FeedStore; release: () => void }>();
  const watches = (remoteId: string): boolean =>
    live.getState().target === `thread:${remoteId}`;

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
        // An accepted message starts an agent's work: the moment the offer LF-03 may appear (live-feed KD-5).
        onActivity: () => {
          status.getState().bumpActivity(itemId, Date.now());
          notifications.noteMessageAccepted();
        },
      });
      const unsubscribers = [
        // The root agent's id is the conversation's, so `agentId` keeps the records of its own answer alone.
        live.onChange(
          {
            kinds: ['entries', 'state', 'summary', 'deleted'],
            threadId: remoteId,
            agentId: remoteId,
          },
          (change) => {
            if (change.kind === 'deleted')
              status.getState().setHistory(remoteId, 'deleted');
            else void store.load();
          },
        ),
        live.onReady(() => {
          // Created in this tab and not read yet: the conversation is on the server only from its first message,
          // and the accepted send reads the feed. A read now would be 404 and show «не найдено».
          const { loaded, view } = store.getState();
          if (watches(remoteId) && !(loaded && view === null))
            void store.load();
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
export function createShellServices({
  openEventSource,
  location,
}: CreateShellServicesOptions = {}): ShellServices {
  const apiClient = threadsApiClient;
  const currentUser = createCurrentUserStore({
    read: authApi.me,
    endSession: authApi.signOut,
    location,
    logger,
  });
  const status = createShellStatusStore();
  const announcer = createAnnouncerStore();
  const live = createLiveStore({ openEventSource, announcer, logger });
  const notifications = createNotificationsStore({ logger });
  const feeds = createThreadFeeds({
    api: apiClient,
    status,
    live,
    announcer,
    notifications,
  });
  const listAdapter = createThreadListAdapter({
    api: apiClient,
    status,
    notify,
    feeds,
  });
  let agentList: AgentListStore | undefined;
  let libraryIndex: LibraryIndex | undefined;
  let search: SearchStore | undefined;

  return {
    apiClient,
    status,
    live,
    announcer,
    feeds,
    currentUser,
    notifications,
    get agentList() {
      agentList ??= createAgentListStore({ api: apiClient, live, logger });
      return agentList;
    },
    get libraryIndex() {
      libraryIndex ??= createLibraryIndex({ read: libraryApi.list, logger });
      return libraryIndex;
    },
    get search() {
      search ??= createSearchStore({ api: apiClient, logger });
      return search;
    },
    composerSeed: createComposerSeed(),
    createdHandoff: createCreatedHandoff(),
    leaveGuard: createLeaveGuard(),
    workspace: createWorkspaceStore(),
    listAdapter,
    auiConfig: AuiConfig({}),
    // `window` is read at the call: the services are also built during server rendering.
    navigate: (url) => (location ?? window.location).assign(url),
  };
}
