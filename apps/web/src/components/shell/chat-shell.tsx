'use client';

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { RecordFocusAction } from '@agent-os/contracts';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Layout, LayoutChangedMeta } from 'react-resizable-panels';
import { useStore } from 'zustand';
import { AgentFeedProvider } from '@/components/agents/agent-feed-provider';
import { LocaleSync } from '@/i18n/locale-sync';
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from '@/components/ui/sidebar';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useLeaveGuardHistory } from '@/hooks/use-leave-guard-history';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  setAdminRequiredHandler,
  setUnauthorizedHandler,
} from '@/lib/api/api-request';
import { redirectToLogin } from '@/lib/auth/session-redirect';
import { useFeedStoreSelector } from '@/lib/feed/feed-context';
import type { FeedState, FeedStore } from '@/lib/feed/feed-store';
import { selectThreadId } from '@/lib/feed/to-feed';
import type { FocusTarget } from '@/lib/focus';
import { asideOf, asideOnScreen } from '@/lib/shell/workspace-store';
import type { OpenEventSource } from '@/lib/live/live-store';
import {
  isPageRoute,
  parseShellRoute,
  type ShellRoute,
} from '@/lib/shell-route';
import { Announcer } from './announcer';
import { AppSidebar } from './app-sidebar';
import { asideReturnElement } from './aside-chat';
import { ChatHeader } from './chat-header';
import { ChatRuntimeProvider } from './chat-runtime-provider';
import { ConnectionBar } from './connection-bar';
import { DocumentTitle } from './document-title';
import { LeaveGuardDialog } from './leave-guard-dialog';
import { MainView, useConversationFeed } from './main-view';
import { SchemaPanel, useChatTasks, type ChatTasks } from './schema-panel';
import { useShellServices } from './shell-actions';
import {
  FEED_MIN_WIDTH,
  WORKSPACE_DEFAULT_SIZE,
  WORKSPACE_PANEL_ID,
  WorkspaceDrawer,
  WorkspacePanel,
  toggleElement,
} from './workspace-panel';

/** Main-area width (window minus sidebar) that fits the panel (360 px) beside the feed (480 px). */
const WORKSPACE_FIT_WIDTH = 840;

type ChatShellProps = {
  /** Sidebar state read by the `(chat)` layout from the `sidebar_state` cookie: the first frame matches it. */
  defaultSidebarOpen: boolean;
  /** Opens the live stream; the `(chat)` layout leaves it out, only the test harness passes one. */
  openEventSource?: OpenEventSource;
  /** Whole-tab navigation of the shell services; the `(chat)` layout leaves it out, only the test harness passes one. */
  location?: Pick<Location, 'assign'>;
  children: ReactNode;
};

/** SH-01: sidebar (built-in or drawer) and the main area, on the full height of the dynamic viewport. */
export function ChatShell({
  defaultSidebarOpen,
  openEventSource,
  location,
  children,
}: ChatShellProps) {
  // Every 401 inside the shell leaves for /login (DC-13). The handler is checked when a response
  // arrives, so the requests children start in their own effects are covered too.
  useEffect(() => {
    setUnauthorizedHandler((code) => redirectToLogin(code));
    return () => setUnauthorizedHandler(null);
  }, []);

  return (
    <SidebarProvider
      defaultOpen={defaultSidebarOpen}
      className="h-dvh overflow-hidden"
    >
      <ChatRuntimeProvider
        openEventSource={openEventSource}
        location={location}
      >
        <AdminRightWatch />
        <ShellLocaleSync />
        <ShellAnnouncer />
        <GlobalShortcuts />
        <LeaveGuard />
        <SkipLink />
        <AppSidebar />
        <ShellMain>{children}</ShellMain>
        <CloseDrawerOnDesktop />
      </ChatRuntimeProvider>
    </SidebarProvider>
  );
}

/** Focus actions that open the panel by themselves from 1024 px (deep-agents UXRD KD-7); a read, a delete or a start does not. */
const OPENING_ACTIONS: ReadonlySet<RecordFocusAction> = new Set([
  'created',
  'changed',
]);

/**
 * The main area: the chat panel and the diagram panel (WS-01…WS-03, deep-agents DA-12) — beside the feed while
 * open from 1024 px, a drawer below it. Opening the panel where the main area is narrower than 840 px folds the
 * sidebar for the time it stays open, without touching the saved `sidebar_state` cookie.
 */
function ShellMain({ children }: { children: ReactNode }) {
  const route = parseShellRoute(usePathname());
  // Agent, panel and library routes have no diagram (UXRD KD-1): its button is hidden and an open panel closes.
  const workspaceAllowed = route.kind === 'chat';
  const { live, workspace } = useShellServices();
  const workspaceOpen = useStore(workspace, (state) => state.open);
  // The dragged width lives for the tab session only.
  const [workspaceSize, setWorkspaceSize] = useState<number>();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const workspaceVisible = workspaceOpen && desktop && workspaceAllowed;
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const mainRef = useRef<HTMLElement>(null);
  const sidebarOpenRef = useRef(sidebarOpen);
  const sidebarFoldedRef = useRef(false);
  const feed = useConversationFeed();
  // A test run's or a training's own conversation: no «Задачи», and the panel never opens by itself (KD-6).
  const runRoot = useFeedStoreSelector(
    feed,
    (state) => state.view?.training?.isRoot === true,
    false,
  );
  const chatTasks = useChatTasks(workspaceAllowed && !runRoot ? feed : null);
  const threadId = useFeedStoreSelector(
    feed,
    (state) => selectThreadId(state.view),
    null,
  );
  const asideShown = useStore(workspace, (state) =>
    asideOnScreen(state, threadId),
  );

  // The user expanding the sidebar while the panel is open takes the fold over.
  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
    if (sidebarOpen) sidebarFoldedRef.current = false;
  }, [sidebarOpen]);

  useEffect(() => {
    if (!workspaceAllowed) workspace.close();
  }, [workspaceAllowed, workspace]);

  // Whoever opened the panel (the header, a record card, a record change), it folds a sidebar that leaves no room.
  useEffect(() => {
    if (workspaceVisible) {
      const mainWidth = mainRef.current?.getBoundingClientRect().width ?? 0;
      if (sidebarOpenRef.current && mainWidth < WORKSPACE_FIT_WIDTH) {
        setSidebarOpen(false, { persist: false });
        sidebarFoldedRef.current = true;
      }
    } else if (sidebarFoldedRef.current) {
      sidebarFoldedRef.current = false;
      setSidebarOpen(true, { persist: false });
    }
  }, [workspaceVisible, setSidebarOpen]);

  // Closed on the side chat, focus goes back to where it was asked (improvements UXRD Accessibility).
  const returnFocusElement = (): HTMLElement | null => {
    const state = workspace.getState();
    const aside = asideOf(state, threadId);
    return state.tab === 'aside' && aside !== null
      ? asideReturnElement(aside)
      : toggleElement();
  };

  const closeWorkspace = (): void => {
    const target = returnFocusElement();
    workspace.close();
    target?.focus();
  };

  const toggleWorkspace = (): void => {
    if (workspaceOpen) closeWorkspace();
    else workspace.show({ focusHeading: true });
  };

  const rememberWorkspaceSize = (
    layout: Layout,
    meta: LayoutChangedMeta,
  ): void => {
    const size = layout[WORKSPACE_PANEL_ID];
    if (meta.isUserInteraction && size !== undefined && size > 0)
      setWorkspaceSize(size);
  };

  return (
    <SidebarInset ref={mainRef} className="min-h-0 min-w-0">
      {workspaceAllowed && feed !== null && !runRoot && (
        <SchemaAutoOpen feed={feed} chatTasks={chatTasks} desktop={desktop} />
      )}
      <ResizablePanelGroup
        orientation="horizontal"
        onLayoutChanged={rememberWorkspaceSize}
      >
        <ResizablePanel
          id="chat"
          minSize={FEED_MIN_WIDTH}
          className="flex flex-col"
          style={{ overflow: 'hidden' }}
        >
          <RouteFeedProvider route={route}>
            <DocumentTitle />
            <ChatHeader
              workspaceOpen={workspaceOpen && workspaceAllowed}
              onToggleWorkspace={toggleWorkspace}
            />
            <ConnectionBar live={live} />
            <div className="min-h-0 flex-1">
              <MainView />
            </div>
          </RouteFeedProvider>
        </ResizablePanel>
        {workspaceVisible && (
          <WorkspacePanel
            defaultSize={
              workspaceSize === undefined
                ? WORKSPACE_DEFAULT_SIZE
                : `${workspaceSize}%`
            }
            onClose={closeWorkspace}
            run={runRoot}
            aside={asideShown}
          >
            <SchemaPanel feed={feed} chatTasks={chatTasks} />
          </WorkspacePanel>
        )}
      </ResizablePanelGroup>
      {workspaceAllowed && !desktop && (
        <WorkspaceDrawer
          open={workspaceOpen}
          onClose={() => workspace.close()}
          returnFocus={returnFocusElement}
          run={runRoot}
          aside={asideShown}
        >
          <SchemaPanel feed={feed} chatTasks={chatTasks} />
        </WorkspaceDrawer>
      )}
      {children}
    </SidebarInset>
  );
}

type SchemaAutoOpenProps = {
  feed: FeedStore;
  chatTasks: ChatTasks;
  desktop: boolean;
};

/**
 * deep-agents UXRD KD-7, DA-12: from 1024 px the panel opens by itself — on «Схема» when the conversation's focus
 * moves to a new event that created or changed a record, on «Задачи» when the conversation gets its first task.
 * What the conversation already had when it was opened is not an event, and after «×» the panel waits for the
 * next one. An open side chat keeps the panel on «В стороне» (improvements KD-1). Focus stays in the feed; below 1024 px nothing opens and no tab is switched, so the drawer never covers
 * the conversation.
 */
function SchemaAutoOpen({ feed, chatTasks, desktop }: SchemaAutoOpenProps) {
  const { workspace } = useShellServices();
  const desktopRef = useRef(desktop);
  useEffect(() => {
    desktopRef.current = desktop;
  }, [desktop]);

  useEffect(() => {
    // undefined until the conversation's first read: what it shows then happened before this visit.
    let seen: string | null | undefined;
    const check = ({ view }: FeedState): void => {
      if (view?.kind !== 'thread') return;
      const onAside = asideOnScreen(workspace.getState(), view.threadId);
      const focus = view.focus;
      const key =
        focus === null ? null : `${focus.recordId}|${focus.action}|${focus.at}`;
      if (seen === undefined || key === seen) {
        seen = key;
        return;
      }
      seen = key;
      if (
        focus !== null &&
        OPENING_ACTIONS.has(focus.action) &&
        desktopRef.current &&
        !onAside
      ) {
        workspace.show({ tab: 'schema', focusHeading: false });
      }
    };
    check(feed.getState());
    return feed.subscribe(check);
  }, [feed, workspace]);

  // The tab «Задачи» as the last read of this root showed it; the first read only records it.
  const { rootAgentId, tasks, tabShown } = chatTasks;
  const threadId = useFeedStoreSelector(
    feed,
    (state) => selectThreadId(state.view),
    null,
  );
  const read = tasks.status === 'ready' && rootAgentId !== null;
  const seenTab = useRef<{ rootAgentId: string; tabShown: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!read || rootAgentId === null) return;
    const before = seenTab.current;
    seenTab.current = { rootAgentId, tabShown };
    if (
      before?.rootAgentId === rootAgentId &&
      !before.tabShown &&
      tabShown &&
      desktopRef.current &&
      !asideOnScreen(workspace.getState(), threadId)
    ) {
      workspace.show({ tab: 'tasks', focusHeading: false });
    }
  }, [read, rootAgentId, tabShown, workspace, threadId]);

  return null;
}

/**
 * On an agent page the header, the screen and the tab title read one agent store (plan Note 4), keyed by
 * the agent so another agent gets a fresh one. It wraps the chat panel only: the sidebar is not remounted
 * when the route moves between a conversation and an agent.
 */
function RouteFeedProvider({
  route,
  children,
}: {
  route: ShellRoute;
  children: ReactNode;
}) {
  if (route.kind !== 'agent') return children;
  return (
    <AgentFeedProvider key={route.agentId} agentId={route.agentId}>
      {children}
    </AgentFeedProvider>
  );
}

/**
 * First stop in the Tab order; visible only while focused. The panel, the library and the schedules have no composer: there
 * it leads to the screen's `h1`.
 */
function SkipLink() {
  const t = useTranslations('shell.skipLink');
  const panel = isPageRoute(parseShellRoute(usePathname()));
  const target: FocusTarget = panel ? 'page-title' : 'composer';
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    document
      .querySelector<HTMLElement>(`[data-shell-focus="${target}"]`)
      ?.focus();
  };

  return (
    <a
      href={panel ? '#page-title' : '#composer'}
      onClick={onClick}
      className="bg-background text-foreground focus-visible:ring-ring sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus-visible:ring-3"
    >
      {panel ? t('content') : t('message')}
    </a>
  );
}

/**
 * Any 403 `ADMIN_REQUIRED` inside the shell takes the administrator right away from the shared
 * `CurrentUser` (KD-2), so the panel, its sidebar and its menu item disappear at once. Mounted inside
 * the runtime provider because it needs the shell services; `lib/api` never imports `CurrentUser`.
 */
function AdminRightWatch() {
  const { currentUser } = useShellServices();
  useEffect(() => {
    setAdminRequiredHandler(() => currentUser.revokeAdmin());
    return () => setAdminRequiredHandler(null);
  }, [currentUser]);
  return null;
}

/** A choice made on another device takes over the page language after the employee is read (i18n DC-3). */
function ShellLocaleSync() {
  const { currentUser } = useShellServices();
  return <LocaleSync currentUser={currentUser} />;
}

/** The shell's only polite live region (design-web.md, «Доступность»). */
function ShellAnnouncer() {
  const { announcer } = useShellServices();
  return <Announcer announcer={announcer} />;
}

/** Ctrl/⌘+Shift+O → «Новый чат»; needs the shell actions, so it mounts inside the runtime provider. */
function GlobalShortcuts() {
  useGlobalShortcuts();
  return null;
}

/** KD-4: closing the tab and «Назад» while unsaved changes are held, and the one MC-11 dialog of the shell. */
function LeaveGuard() {
  useLeaveGuardHistory();
  return <LeaveGuardDialog />;
}

/** Crossing to ≥ 768 px closes the drawer, so it does not reopen by itself when the window narrows again. */
function CloseDrawerOnDesktop() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (!isMobile && openMobile) setOpenMobile(false);
  }, [isMobile, openMobile, setOpenMobile]);
  return null;
}
