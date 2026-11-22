'use client';

import { useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { AccountScreen } from '@/components/account/account-screen';
import { AdminGate } from '@/components/admin/admin-gate';
import { AgentScreen } from '@/components/agents/agent-screen';
import { AgentsScreen } from '@/components/agents/agents-screen';
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { KnowledgePage } from '@/components/library/knowledge-page';
import { LibraryScreen } from '@/components/library/library-screen';
import { NewRecordPage, RecordPage } from '@/components/library/record-page';
import { FeedProvider } from '@/lib/feed/feed-context';
import type { FeedStore } from '@/lib/feed/feed-store';
import { focusShellTarget } from '@/lib/focus';
import { NEW_THREAD_TARGET } from '@/lib/threads/composer-seed';
import { selectMainItem } from '@/lib/threads/main-thread';
import { resolveMainView, type MainView as MainViewKind } from '@/lib/threads/resolve-main-view';
import { parseShellRoute } from '@/lib/shell-route';
import { useShellActions, useShellServices, useShellStatus } from './shell-actions';
import { ShellWelcome } from './shell-welcome';
import { DeletedNotice, ThreadNotice } from './thread-notice';

export type MainViewState = {
  view: MainViewKind;
  routeThreadId: string | undefined;
  mainRemoteId: string | undefined;
};

/** Inputs of `resolveMainView` read from the route, the runtime and ShellStatus; shared by MainView and HD-03. */
export function useMainViewState(): MainViewState {
  const route = parseShellRoute(usePathname());
  const routeThreadId = route.kind === 'chat' ? route.threadId : undefined;
  const mainRemoteId = useAuiState(
    (s) => selectMainItem(s)?.remoteId);
  const switchError = useAuiState((s) => s.threads.switchError);
  const historyStatus = useShellStatus((s) => (mainRemoteId === undefined ? undefined : s.history[mainRemoteId]));

  return {
    view: resolveMainView({ routeThreadId, mainRemoteId, switchError, historyStatus }),
    routeThreadId,
    mainRemoteId,
  };
}

/**
 * The open conversation's store, the same one its runtime reads; none on `/` before the first message. The list
 * item it lifts on activity is the one it was created with. Shared by the feed and the diagram panel.
 */
export function useConversationFeed(): FeedStore | null {
  const { mainRemoteId } = useMainViewState();
  const { feeds } = useShellServices();
  const mainItemId = useAuiState((s) => s.threadListItem.id);
  return useMemo(
    () => (mainRemoteId === undefined ? null : feeds.forThread(mainRemoteId, mainItemId)),
    [feeds, mainRemoteId, mainItemId],
  );
}

const THREAD_COMPONENTS: ThreadComponents = { Welcome: ShellWelcome };
/** E-8: the open thread was deleted elsewhere — the feed stays, the notice takes the composer's place. */
const DELETED_THREAD_COMPONENTS: ThreadComponents = { Welcome: ShellWelcome, DeletedNotice };

/**
 * The main area by route: `/agents` — the agent tree (Screen 2); `/agents/<id>` — the agent page (Screen 3)
 * under the shell's `AgentFeedProvider`; `/account` — «Мой доступ»; a conversation — the feed (its skeleton
 * with a send-blocked composer while the URL thread resolves; E-8 notice once deleted), or TH-06 / TH-07;
 * `/admin/…` — the panel behind `AdminGate`; `/library` — the library list; `/library/<id>` — the record page.
 */
export function MainView() {
  const route = parseShellRoute(usePathname());
  const services = useShellServices();

  if (route.kind === 'agents') return <AgentsScreen store={services.agentList} />;
  if (route.kind === 'agent') return <AgentScreen />;
  if (route.kind === 'account') return <AccountScreen currentUser={services.currentUser} />;
  if (route.kind === 'admin') return <AdminGate route={route} />;
  if (route.kind === 'library' && route.page.kind === 'list') return <LibraryScreen />;
  // Self-learning KD-2: a deep agent's knowledge; a new key per deep agent, so nothing of one carries over to the next.
  if (route.kind === 'library' && route.page.kind === 'knowledge') {
    return <KnowledgePage key={route.page.id} id={route.page.id} variant="library" />;
  }
  // A new key per record: the copy dialog and focus of one record never carry over to the next.
  if (route.kind === 'library' && route.page.kind === 'record') return <RecordPage key={route.page.id} id={route.page.id} />;
  if (route.kind === 'library' && route.page.kind === 'new') return <NewRecordPage />;
  return <ConversationView />;
}

function ConversationView() {
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  const { newChat, leaveTo, retrySwitch, retryHistory } = useShellActions();
  const { libraryIndex, composerSeed } = useShellServices();
  const feed = useConversationFeed();
  // The run labels and the cards read the library list on entering each conversation (KD-2).
  useEffect(() => {
    void libraryIndex.refresh();
  }, [libraryIndex, routeThreadId]);
  // Until the runtime has put the first read into the thread, a URL thread keeps the skeleton
  // (no welcome flash while the list is still loading).
  const bodyLoading = useAuiState((s) => s.thread.isLoading && s.thread.messages.length === 0);
  const notFound = view.kind === 'not-found';
  // custom-agents Flow 3: the conversation a chip was put for is gone — the chip goes to a new one (CH-01).
  useEffect(() => {
    if (!notFound || routeThreadId === undefined || !composerSeed.getState().chips.has(routeThreadId)) return;
    composerSeed.move(routeThreadId, NEW_THREAD_TARGET);
    leaveTo('/');
    focusShellTarget('composer');
  }, [notFound, routeThreadId, composerSeed, leaveTo]);
  // The composer's seed target: the conversation, or the new one on `/` until its first message creates it.
  const seedTarget = routeThreadId ?? mainRemoteId ?? NEW_THREAD_TARGET;

  switch (view.kind) {
    // One element for both kinds: the composer is not remounted when the history arrives.
    case 'thread':
    case 'switching':
      return (
        <FeedProvider feed={feed}>
          <Thread
            components={view.kind === 'thread' && view.deleted ? DELETED_THREAD_COMPONENTS : THREAD_COMPONENTS}
            historyPending={view.kind === 'switching' || (routeThreadId !== undefined && bodyLoading)}
            seedTarget={seedTarget}
          />
        </FeedProvider>
      );
    case 'not-found':
      return <ThreadNotice variant="not-found" onNewChat={newChat} />;
    case 'load-error': {
      const onRetry = () => {
        if (view.retry === 'switch' && routeThreadId !== undefined) retrySwitch(routeThreadId);
        if (view.retry === 'history' && mainRemoteId !== undefined) retryHistory(mainRemoteId);
      };
      return <ThreadNotice variant="load-error" onRetry={onRetry} onNewChat={newChat} />;
    }
  }
}
