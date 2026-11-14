'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { AgentScreen } from '@/components/agents/agent-screen';
import { AgentsScreen } from '@/components/agents/agents-screen';
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { FeedProvider } from '@/lib/feed/feed-context';
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
    (s) =>
      s.threads.threadItems.find(
        (item) => item.id === s.threads.mainThreadId || item.remoteId === s.threads.mainThreadId,
      )?.remoteId,
  );
  const switchError = useAuiState((s) => s.threads.switchError);
  const historyStatus = useShellStatus((s) => (mainRemoteId === undefined ? undefined : s.history[mainRemoteId]));

  return {
    view: resolveMainView({ routeThreadId, mainRemoteId, switchError, historyStatus }),
    routeThreadId,
    mainRemoteId,
  };
}

const THREAD_COMPONENTS: ThreadComponents = { Welcome: ShellWelcome };
/** E-8: the open thread was deleted elsewhere — the feed stays, the notice takes the composer's place. */
const DELETED_THREAD_COMPONENTS: ThreadComponents = { Welcome: ShellWelcome, DeletedNotice };

/**
 * The main area by route: `/agents` — the agent tree (Screen 2); `/agents/<id>` — the agent page (Screen 3)
 * under the shell's `AgentFeedProvider`; a conversation — the feed (its skeleton with a send-blocked
 * composer while the URL thread resolves; E-8 notice once deleted), or TH-06 / TH-07.
 */
export function MainView() {
  const route = parseShellRoute(usePathname());
  const services = useShellServices();

  if (route.kind === 'agents') return <AgentsScreen store={services.agentList} />;
  if (route.kind === 'agent') return <AgentScreen />;
  return <ConversationView />;
}

function ConversationView() {
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  const { newChat, retrySwitch, retryHistory } = useShellActions();
  const { feeds } = useShellServices();
  // The list item that lifts in the list on activity; the store keeps the one it was created with.
  const mainItemId = useAuiState((s) => s.threadListItem.id);
  // The conversation's store, the same one its runtime reads; none on `/` before the first message.
  const feed = useMemo(
    () => (mainRemoteId === undefined ? null : feeds.forThread(mainRemoteId, mainItemId)),
    [feeds, mainRemoteId, mainItemId],
  );
  // Until the runtime has put the first read into the thread, a URL thread keeps the skeleton
  // (no welcome flash while the list is still loading).
  const bodyLoading = useAuiState((s) => s.thread.isLoading && s.thread.messages.length === 0);
  const onNewChat = () => newChat('notice');

  switch (view.kind) {
    // One element for both kinds: the composer is not remounted when the history arrives.
    case 'thread':
    case 'switching':
      return (
        <FeedProvider feed={feed}>
          <Thread
            autoFocus={false}
            components={view.kind === 'thread' && view.deleted ? DELETED_THREAD_COMPONENTS : THREAD_COMPONENTS}
            historyPending={view.kind === 'switching' || (routeThreadId !== undefined && bodyLoading)}
          />
        </FeedProvider>
      );
    case 'not-found':
      return <ThreadNotice variant="not-found" onNewChat={onNewChat} />;
    case 'load-error': {
      const onRetry = () => {
        if (view.retry === 'switch' && routeThreadId !== undefined) retrySwitch(routeThreadId);
        if (view.retry === 'history' && mainRemoteId !== undefined) retryHistory(mainRemoteId);
      };
      return <ThreadNotice variant="load-error" onRetry={onRetry} onNewChat={onNewChat} />;
    }
  }
}
