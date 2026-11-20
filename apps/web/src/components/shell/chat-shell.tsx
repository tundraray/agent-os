'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { Layout, LayoutChangedMeta } from 'react-resizable-panels';
import { AgentFeedProvider } from '@/components/agents/agent-feed-provider';
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useLeaveGuardHistory } from '@/hooks/use-leave-guard-history';
import { useMediaQuery } from '@/hooks/use-media-query';
import { setAdminRequiredHandler, setUnauthorizedHandler } from '@/lib/api/api-request';
import { redirectToLogin } from '@/lib/auth/session-redirect';
import type { FocusTarget } from '@/lib/focus';
import type { OpenEventSource } from '@/lib/live/live-store';
import { parseShellRoute, type ShellRoute } from '@/lib/shell-route';
import { Announcer } from './announcer';
import { AppSidebar } from './app-sidebar';
import { ChatHeader } from './chat-header';
import { ChatRuntimeProvider } from './chat-runtime-provider';
import { ConnectionBar } from './connection-bar';
import { DocumentTitle } from './document-title';
import { LeaveGuardDialog } from './leave-guard-dialog';
import { MainView } from './main-view';
import { useShellServices } from './shell-actions';
import {
  FEED_MIN_WIDTH,
  WORKSPACE_DEFAULT_SIZE,
  WORKSPACE_PANEL_ID,
  WorkspacePanel,
} from './workspace-panel';

/** Main-area width (window minus sidebar) that fits the workspace (360 px) beside the feed (480 px). */
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
export function ChatShell({ defaultSidebarOpen, openEventSource, location, children }: ChatShellProps) {
  // Every 401 inside the shell leaves for /login (DC-13). The handler is checked when a response
  // arrives, so the requests children start in their own effects are covered too.
  useEffect(() => {
    setUnauthorizedHandler((code) => redirectToLogin(code));
    return () => setUnauthorizedHandler(null);
  }, []);

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen} className="h-dvh overflow-hidden">
      <ChatRuntimeProvider openEventSource={openEventSource} location={location}>
        <AdminRightWatch />
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

const focusWorkspaceToggle = (): void => {
  document.querySelector<HTMLElement>('[data-shell-focus="workspace-toggle"]')?.focus();
};

/**
 * The main area: the chat panel and, while open on ≥ 1024 px, the workspace panel (WS-01…WS-03).
 * Opening it where the main area is narrower than 840 px folds the sidebar for the time it stays open,
 * without touching the saved `sidebar_state` cookie.
 */
function ShellMain({ children }: { children: ReactNode }) {
  const route = parseShellRoute(usePathname());
  // Agent, panel and library routes have no workspace (UXRD KD-1): its button is hidden and an open workspace closes.
  const workspaceAllowed = route.kind === 'chat';
  // The user's intent and the dragged width live for the tab session only.
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSize, setWorkspaceSize] = useState<number>();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const workspaceVisible = workspaceOpen && desktop && workspaceAllowed;
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const mainRef = useRef<HTMLElement>(null);
  const sidebarFoldedRef = useRef(false);
  const { live } = useShellServices();

  // The user expanding the sidebar while the workspace is open takes the fold over.
  useEffect(() => {
    if (sidebarOpen) sidebarFoldedRef.current = false;
  }, [sidebarOpen]);

  if (!workspaceAllowed && workspaceOpen) setWorkspaceOpen(false);
  useEffect(() => {
    if (workspaceAllowed || workspaceOpen) return;
    if (sidebarFoldedRef.current) {
      sidebarFoldedRef.current = false;
      setSidebarOpen(true, { persist: false });
    }
  }, [workspaceAllowed, workspaceOpen, setSidebarOpen]);

  const openWorkspace = (): void => {
    const mainWidth = mainRef.current?.getBoundingClientRect().width ?? 0;
    if (sidebarOpen && mainWidth < WORKSPACE_FIT_WIDTH) {
      setSidebarOpen(false, { persist: false });
      sidebarFoldedRef.current = true;
    }
    setWorkspaceOpen(true);
  };

  const closeWorkspace = (): void => {
    setWorkspaceOpen(false);
    if (sidebarFoldedRef.current) {
      sidebarFoldedRef.current = false;
      setSidebarOpen(true, { persist: false });
    }
    focusWorkspaceToggle();
  };

  const rememberWorkspaceSize = (layout: Layout, meta: LayoutChangedMeta): void => {
    const size = layout[WORKSPACE_PANEL_ID];
    if (meta.isUserInteraction && size !== undefined && size > 0) setWorkspaceSize(size);
  };

  return (
    <SidebarInset ref={mainRef} className="min-h-0 min-w-0">
      <ResizablePanelGroup orientation="horizontal" onLayoutChanged={rememberWorkspaceSize}>
        <ResizablePanel id="chat" minSize={FEED_MIN_WIDTH} className="flex flex-col" style={{ overflow: 'hidden' }}>
          <RouteFeedProvider route={route}>
            <DocumentTitle />
            <ChatHeader
              workspaceOpen={workspaceVisible}
              onToggleWorkspace={workspaceOpen ? closeWorkspace : openWorkspace}
            />
            <ConnectionBar live={live} />
            <div className="min-h-0 flex-1">
              <MainView />
            </div>
          </RouteFeedProvider>
        </ResizablePanel>
        {workspaceVisible && (
          <WorkspacePanel
            defaultSize={workspaceSize === undefined ? WORKSPACE_DEFAULT_SIZE : `${workspaceSize}%`}
            onClose={closeWorkspace}
          />
        )}
      </ResizablePanelGroup>
      {children}
    </SidebarInset>
  );
}

/**
 * On an agent page the header, the screen and the tab title read one agent store (plan Note 4), keyed by
 * the agent so another agent gets a fresh one. It wraps the chat panel only: the sidebar is not remounted
 * when the route moves between a conversation and an agent.
 */
function RouteFeedProvider({ route, children }: { route: ShellRoute; children: ReactNode }) {
  if (route.kind !== 'agent') return children;
  return (
    <AgentFeedProvider key={route.agentId} agentId={route.agentId}>
      {children}
    </AgentFeedProvider>
  );
}

/**
 * First stop in the Tab order; visible only while focused. The panel and the library have no composer: there it
 * leads to the screen's `h1`.
 */
function SkipLink() {
  const kind = parseShellRoute(usePathname()).kind;
  const panel = kind === 'admin' || kind === 'library';
  const target: FocusTarget = panel ? 'page-title' : 'composer';
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    document.querySelector<HTMLElement>(`[data-shell-focus="${target}"]`)?.focus();
  };

  return (
    <a
      href={panel ? '#page-title' : '#composer'}
      onClick={onClick}
      className="bg-background text-foreground focus-visible:ring-ring sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus-visible:ring-3"
    >
      {panel ? 'Перейти к содержимому' : 'Перейти к сообщению'}
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
