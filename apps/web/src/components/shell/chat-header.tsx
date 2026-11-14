'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { MenuIcon, PanelLeftIcon, PanelLeftOpenIcon, PanelRightIcon, SquarePenIcon } from 'lucide-react';
import { AgentHeader } from '@/components/agents/agent-header';
import { pressable, ShimmerLabel } from '@/components/surfaces';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useShortcutLabel } from '@/hooks/use-global-shortcuts';
import { parseShellRoute } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { MENU_BUTTON_ATTRIBUTE, SIDEBAR_ID } from './app-sidebar';
import { useMainViewState } from './main-view';
import { useShellActions, useShellStatus } from './shell-actions';
import { WORKSPACE_ID } from './workspace-panel';

/**
 * HD-03 content: `hidden` on `/`, `loading` until the open thread's metadata is known, `empty` on TH-06 / TH-07
 * (no title, no skeleton), `text` otherwise.
 */
export type HeaderTitle =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'text'; text: string; pending: boolean };

export type ChatHeaderViewProps = {
  title: HeaderTitle;
  workspaceOpen: boolean;
  onToggleWorkspace: () => void;
  onNewChat: () => void;
  /** The thread feed is scrolled away from its top: the header shows its bottom border. */
  scrolled?: boolean;
  /** Content of the HD-03 slot in place of the title, with its own `h1` (the agent page's AV-01). */
  heading?: ReactNode;
  /** HD-04 «Рабочая область»; agent routes have no workspace (UXRD KD-1). */
  showWorkspaceToggle?: boolean;
};

/** Placeholder for a thread without a title (D-06). */
const UNTITLED = 'Новая беседа';

const THREAD_VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';

const iconButton = cn(pressable, 'shrink-0 [&_svg]:size-4.5');

/** HD-01: presentational header; the sidebar state comes from `SidebarProvider`, the rest from props. */
export function ChatHeaderView({
  title,
  workspaceOpen,
  onToggleWorkspace,
  onNewChat,
  scrolled = false,
  heading,
  showWorkspaceToggle = true,
}: ChatHeaderViewProps) {
  const { open, toggleSidebar } = useSidebar();
  const menuButtonProps = { [MENU_BUTTON_ATTRIBUTE]: '' };
  const sidebarShortcut = useShortcutLabel('toggle-sidebar');
  const newChatShortcut = useShortcutLabel('new-chat');

  return (
    <header
      data-scrolled={scrolled ? '' : undefined}
      className="bg-background flex h-(--header-height) shrink-0 items-center gap-1 border-b border-transparent px-2 md:px-3 data-scrolled:border-border"
    >
      <WithTooltip label={`Меню · ${sidebarShortcut}`}>
        <Button
          {...menuButtonProps}
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'size-11 md:hidden')}
          aria-label="Меню"
          aria-haspopup="dialog"
          onClick={toggleSidebar}
        >
          <MenuIcon aria-hidden />
        </Button>
      </WithTooltip>
      <WithTooltip label={`Боковая панель · ${sidebarShortcut}`}>
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'hidden size-8 md:inline-flex')}
          aria-label="Боковая панель"
          aria-expanded={open}
          aria-controls={SIDEBAR_ID}
          aria-keyshortcuts="Control+B Meta+B"
          onClick={toggleSidebar}
        >
          {open ? <PanelLeftIcon aria-hidden /> : <PanelLeftOpenIcon aria-hidden />}
        </Button>
      </WithTooltip>
      {heading ?? <PageTitle title={title} />}
      {showWorkspaceToggle && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'aria-expanded:bg-accent hidden size-8 lg:inline-flex')}
          aria-label="Рабочая область"
          aria-expanded={workspaceOpen}
          aria-controls={workspaceOpen ? WORKSPACE_ID : undefined}
          data-shell-focus="workspace-toggle"
          onClick={onToggleWorkspace}
        >
          <PanelRightIcon aria-hidden />
        </Button>
      )}
      <WithTooltip label={`Новый чат · ${newChatShortcut}`}>
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'size-11 md:hidden')}
          aria-label="Новый чат"
          aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
          onClick={onNewChat}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </WithTooltip>
    </header>
  );
}

/** Header icon button with its name and shortcut in a tooltip below it. */
function WithTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** HD-03: the page's level-one heading; focused programmatically after navigation with a coarse pointer. */
function PageTitle({ title }: { title: HeaderTitle }) {
  return (
    <h1
      tabIndex={-1}
      data-shell-focus="page-title"
      aria-busy={title.kind === 'loading' ? true : undefined}
      className="min-w-0 flex-1 truncate px-1 text-sm font-medium outline-none"
    >
      {title.kind === 'hidden' && <span className="sr-only">Новый чат</span>}
      {title.kind === 'loading' && <Skeleton aria-hidden className="h-4 w-40" />}
      {title.kind === 'text' && (
        <ShimmerLabel active={title.pending} title={title.text}>
          {title.text}
        </ShimmerLabel>
      )}
    </h1>
  );
}

type ChatHeaderProps = {
  workspaceOpen: boolean;
  onToggleWorkspace: () => void;
};

/**
 * HD-01 container: derives the title from the route and the runtime, and wires the shell actions.
 * `/agents` → «Агенты» (MC-4); an agent page → `AgentHeader` (AV-01), which needs `AgentFeedProvider`
 * above; neither has the workspace button.
 */
export function ChatHeader({ workspaceOpen, onToggleWorkspace }: ChatHeaderProps) {
  const { newChat } = useShellActions();
  const route = parseShellRoute(usePathname());
  const title = useHeaderTitle();
  const scrolled = useThreadScrolled();

  return (
    <ChatHeaderView
      title={route.kind === 'agents' ? AGENTS_TITLE : title}
      heading={route.kind === 'agent' ? <AgentHeader /> : undefined}
      showWorkspaceToggle={route.kind === 'chat'}
      workspaceOpen={workspaceOpen}
      onToggleWorkspace={onToggleWorkspace}
      onNewChat={() => newChat('button')}
      scrolled={scrolled}
    />
  );
}

/** MC-4: the «Агенты» page heading. */
const AGENTS_TITLE: HeaderTitle = { kind: 'text', text: 'Агенты', pending: false };

/**
 * `/` → hidden. `/chat/<id>` → empty on TH-06 / TH-07; loading while the main view is switching or until
 * the open thread's list metadata is known (a direct link resolves before its item exists); then its title
 * or the pending placeholder.
 */
function useHeaderTitle(): HeaderTitle {
  const { view, routeThreadId } = useMainViewState();
  const mainItem = useAuiState((s) =>
    s.threads.threadItems.find(
      (item) => item.id === s.threads.mainThreadId || item.remoteId === s.threads.mainThreadId,
    ),
  );
  const remoteId = mainItem?.remoteId;
  const titleWaiting = useShellStatus((s) => remoteId !== undefined && s.titleWaiting[remoteId] === true);

  if (routeThreadId === undefined) return { kind: 'hidden' };
  if (view.kind === 'not-found' || view.kind === 'load-error') return { kind: 'empty' };
  if (view.kind === 'switching' || mainItem === undefined || remoteId !== routeThreadId) return { kind: 'loading' };
  const text = mainItem.title?.trim() ?? '';
  if (text !== '') return { kind: 'text', text, pending: false };
  return { kind: 'text', text: UNTITLED, pending: titleWaiting };
}

/** Whether the thread feed is scrolled away from its top; the viewport is owned by `Thread`. */
function useThreadScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Scroll events do not bubble: listen in the capture phase and keep only the feed's viewport.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches(THREAD_VIEWPORT_SELECTOR)) {
        setScrolled(target.scrollTop > 0);
      }
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  return scrolled;
}
