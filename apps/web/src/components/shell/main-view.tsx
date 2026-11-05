'use client';

import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import {
  ComposerResearchModeToggle,
  ThreadResearchProvider,
  useDeepResearchToolUI,
} from '@/components/research/research-thread';
import { resolveMainView, type MainView as MainViewKind } from '@/lib/threads/resolve-main-view';
import { parseRouteThreadId } from '@/lib/threads/route-thread-id';
import { useShellActions, useShellStatus } from './shell-actions';
import { ShellWelcome } from './shell-welcome';
import { DeletedNotice, ThreadNotice } from './thread-notice';

export type MainViewState = {
  view: MainViewKind;
  routeThreadId: string | undefined;
  mainRemoteId: string | undefined;
};

/** Inputs of `resolveMainView` read from the route, the runtime and ShellStatus; shared by MainView and HD-03. */
export function useMainViewState(): MainViewState {
  const routeThreadId = parseRouteThreadId(usePathname());
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

const THREAD_COMPONENTS: ThreadComponents = { Welcome: ShellWelcome, ComposerExtra: ComposerResearchModeToggle };
/** E-8: the open thread was deleted elsewhere — the feed stays, the composer goes, the notice replaces the TH-08 block. */
const DELETED_THREAD_COMPONENTS: ThreadComponents = {
  Welcome: ShellWelcome,
  DeletedNotice,
  ComposerExtra: ComposerResearchModeToggle,
};

/** The main area: the feed (its skeleton with a send-blocked composer while the URL thread resolves; E-8 notice once deleted), or TH-06 / TH-07. */
export function MainView() {
  const { view, routeThreadId, mainRemoteId } = useMainViewState();
  useDeepResearchToolUI();
  const { newChat, retrySwitch, retryHistory } = useShellActions();
  // The history adapter reports 'ready' before the runtime has put the messages into the thread:
  // until they land, a URL thread keeps the skeleton (no welcome flash while the list is still loading).
  const bodyLoading = useAuiState((s) => s.thread.isLoading && s.thread.messages.length === 0);
  const onNewChat = () => newChat('notice');

  switch (view.kind) {
    // One element for both kinds: the composer is not remounted when the history arrives.
    case 'thread':
    case 'switching':
      return (
        <ThreadResearchProvider threadId={mainRemoteId ?? null}>
          <Thread
            autoFocus={false}
            components={view.kind === 'thread' && view.deleted ? DELETED_THREAD_COMPONENTS : THREAD_COMPONENTS}
            historyPending={view.kind === 'switching' || (routeThreadId !== undefined && bodyLoading)}
          />
        </ThreadResearchProvider>
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
