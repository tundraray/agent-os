'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import {
  GitBranchIcon,
  MenuIcon,
  PanelLeftIcon,
  PanelLeftOpenIcon,
  PanelRightIcon,
  SquarePenIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { AgentHeader } from '@/components/agents/agent-header';
import { pressable, ShimmerLabel } from '@/components/surfaces';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useSidebar } from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useShortcutLabel } from '@/hooks/use-global-shortcuts';
import { useResource } from '@/hooks/use-resource';
import { useFeedStoreSelector } from '@/lib/feed/feed-context';
import {
  parseShellRoute,
  recordPath,
  threadPath,
  type ShellRoute,
} from '@/lib/shell-route';
import { selectMainItem } from '@/lib/threads/main-thread';
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { cn } from '@/lib/utils';
import { MENU_BUTTON_ATTRIBUTE, SIDEBAR_ID } from './app-sidebar';
import { useConversationFeed, useMainViewState } from './main-view';
import { PageHeaderSlot } from './page-header';
import { ShellLink } from './shell-link';
import { useShellActions, useShellStatus } from './shell-actions';
import { RunButton, WORKSPACE_ID } from './workspace-panel';

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
  /** HD-04 «Схема» (deep-agents DA-12): the panel from 1024 px, the drawer below it; agent routes have none (UXRD KD-1). */
  showWorkspaceToggle?: boolean;
  /** The open conversation's actions before «Схема»: a test run's «Открыть агента» and «Ход и итог» (KD-6). */
  action?: ReactNode;
};

const THREAD_VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';

const iconButton = cn(pressable, 'shrink-0 [&_svg]:size-4.5');

// Below 640 px the actions are icon buttons, so the title keeps the room (create-and-test, 360 px).
const ACTION = buttonVariants({
  variant: 'outline',
  size: 'sm',
  className:
    'shrink-0 pointer-coarse:h-11 max-sm:size-8 max-sm:px-0 max-sm:pointer-coarse:size-11',
});
const ACTION_TEXT = 'max-sm:sr-only';
const ACTION_ICON = 'sm:hidden';

/** HD-01: presentational header; the sidebar state comes from `SidebarProvider`, the rest from props. */
export function ChatHeaderView({
  title,
  workspaceOpen,
  onToggleWorkspace,
  onNewChat,
  scrolled = false,
  heading,
  showWorkspaceToggle = true,
  action,
}: ChatHeaderViewProps) {
  const t = useTranslations('shell');
  const tCommon = useTranslations('common');
  const { open, toggleSidebar } = useSidebar();
  const menuButtonProps = { [MENU_BUTTON_ATTRIBUTE]: '' };
  const sidebarShortcut = useShortcutLabel('toggle-sidebar');
  const newChatShortcut = useShortcutLabel('new-chat');

  return (
    <header
      data-scrolled={scrolled ? '' : undefined}
      // A panel screen's actions take a second line below 768 px; every other heading fills one line.
      className="bg-background flex min-h-(--header-height) shrink-0 flex-wrap items-center gap-x-1 border-b border-transparent px-2 md:flex-nowrap md:px-3 data-scrolled:border-border"
    >
      <WithTooltip
        label={t('header.menuTooltip', { shortcut: sidebarShortcut })}
      >
        <Button
          {...menuButtonProps}
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'size-11 md:hidden')}
          aria-label={t('header.menu')}
          aria-haspopup="dialog"
          onClick={toggleSidebar}
        >
          <MenuIcon aria-hidden />
        </Button>
      </WithTooltip>
      <WithTooltip
        label={t('header.sidebarTooltip', { shortcut: sidebarShortcut })}
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'hidden size-8 md:inline-flex')}
          aria-label={tCommon('sidebar')}
          aria-expanded={open}
          aria-controls={SIDEBAR_ID}
          aria-keyshortcuts="Control+B Meta+B"
          onClick={toggleSidebar}
        >
          {open ? (
            <PanelLeftIcon aria-hidden />
          ) : (
            <PanelLeftOpenIcon aria-hidden />
          )}
        </Button>
      </WithTooltip>
      {heading ?? <PageTitle title={title} />}
      {action}
      {showWorkspaceToggle && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            iconButton,
            'aria-expanded:bg-accent size-8 pointer-coarse:size-11',
          )}
          aria-label={t('schema.title')}
          aria-expanded={workspaceOpen}
          aria-controls={workspaceOpen ? WORKSPACE_ID : undefined}
          data-shell-focus="workspace-toggle"
          onClick={onToggleWorkspace}
        >
          <PanelRightIcon aria-hidden />
        </Button>
      )}
      <WithTooltip
        label={t('sidebar.newChatTooltip', { shortcut: newChatShortcut })}
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, 'size-11 md:hidden')}
          aria-label={t('sidebar.newChat')}
          aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
          onClick={onNewChat}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </WithTooltip>
    </header>
  );
}

/** Header icon button with its name and shortcut in a tooltip below it; `narrowOnly` while it is an icon (below 640 px). */
function WithTooltip({
  label,
  narrowOnly = false,
  children,
}: {
  label: string;
  narrowOnly?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent
        side="bottom"
        className={narrowOnly ? 'sm:hidden' : undefined}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** HD-03: the page's level-one heading; focused programmatically after navigation with a coarse pointer. */
function PageTitle({ title }: { title: HeaderTitle }) {
  const t = useTranslations('shell.sidebar');
  return (
    <h1
      tabIndex={-1}
      data-shell-focus="page-title"
      aria-busy={title.kind === 'loading' ? true : undefined}
      className="min-w-0 flex-1 truncate px-1 text-sm font-medium outline-none"
    >
      {title.kind === 'hidden' && (
        <span className="sr-only">{t('newChat')}</span>
      )}
      {title.kind === 'loading' && (
        <Skeleton aria-hidden className="h-4 w-40" />
      )}
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
 * `/agents` → «Агенты» (MC-4); `/account` → «Мой доступ» (MC-7); an agent page → `AgentHeader` (AV-01),
 * which needs `AgentFeedProvider` above; a panel or library address → the slot its screen fills through
 * `PageHeader` (AD-01, LB-01); none of them has the diagram button.
 */
export function ChatHeader({
  workspaceOpen,
  onToggleWorkspace,
}: ChatHeaderProps) {
  const { newChat } = useShellActions();
  const t = useTranslations('shell.page');
  const tChat = useTranslations('chat');
  const tSchema = useTranslations('shell.schema');
  const route = parseShellRoute(usePathname());
  const title = useHeaderTitle();
  const scrolled = useThreadScrolled();
  const routeTitle = ROUTE_TITLES[route.kind];
  const training = useFeedStoreSelector(
    useConversationFeed(),
    (state) => state.view?.training ?? null,
    null,
  );
  // A test run's or a training's own conversation: «Ход и итог» in place of «Схема» (KD-6); a training's view needs its agent.
  const run =
    route.kind === 'chat' &&
    training?.isRoot === true &&
    (training.testRun || training.agentId !== null)
      ? training
      : null;

  return (
    <ChatHeaderView
      title={
        routeTitle === undefined
          ? title
          : { kind: 'text', text: t(routeTitle), pending: false }
      }
      heading={routeHeading(route)}
      action={
        route.kind === 'chat' && (
          <>
            <ForksButton />
            {run?.testRun === true && run.agentId !== null && (
              <WithTooltip label={tChat('testRun.openAgent')} narrowOnly>
                <ShellLink href={recordPath(run.agentId)} className={ACTION}>
                  <WorkflowIcon aria-hidden className={ACTION_ICON} />
                  <span className={ACTION_TEXT}>
                    {tChat('testRun.openAgent')}
                  </span>
                </ShellLink>
              </WithTooltip>
            )}
            {/* A test run's button comes with its first card, under the confirmed plan (UXRD CT-03). */}
            {run !== null &&
              (!run.testRun ||
                run.run?.plans.some((plan) => plan.state === 'confirmed')) && (
                <WithTooltip label={tSchema('runTitle')} narrowOnly>
                  <RunButton className={ACTION}>
                    <PanelRightIcon aria-hidden className={ACTION_ICON} />
                    <span className={ACTION_TEXT}>{tSchema('runTitle')}</span>
                  </RunButton>
                </WithTooltip>
              )}
          </>
        )
      }
      showWorkspaceToggle={route.kind === 'chat' && run === null}
      workspaceOpen={workspaceOpen}
      onToggleWorkspace={onToggleWorkspace}
      onNewChat={newChat}
      scrolled={scrolled}
    />
  );
}

const MENU_LINE = 'text-muted-foreground px-1.5 py-1 text-xs leading-4';

/** FK-04: the source conversation's forks, while it has one (KD-10); the menu reads the list at every open. */
function ForksButton() {
  const t = useTranslations('shell.forks');
  const thread = useFeedStoreSelector(
    useConversationFeed(),
    (state) => (state.view?.kind === 'thread' ? state.view.thread : null),
    null,
  );
  if (thread === null || thread.forkCount === 0) return null;
  const count = thread.forkCount;
  return (
    <DropdownMenu>
      <WithTooltip label={t('tooltip', { count })}>
        <DropdownMenuTrigger
          className={buttonVariants({
            variant: 'ghost',
            size: 'sm',
            className:
              'shrink-0 tabular-nums pointer-coarse:h-11 pointer-coarse:min-w-11',
          })}
          aria-label={t('label', { count })}
        >
          <GitBranchIcon aria-hidden />
          {count}
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        <ForksList threadId={thread.id} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** MC-20 items, newest first; mounted with the open menu, so each open reads the list again. */
function ForksList({ threadId }: { threadId: string }) {
  const t = useTranslations('shell.forks');
  const tThread = useTranslations('shell.thread');
  const format = useFormatter();
  const forks = useResource(
    () => threadsApiClient.getThreadForks(threadId),
    threadId,
    'web-shell forks',
  );
  if (forks.status === 'loading')
    return <p className={MENU_LINE}>{t('loading')}</p>;
  if (forks.status === 'error')
    return (
      <>
        <p className={MENU_LINE}>{t('loadFailed')}</p>
        <DropdownMenuItem closeOnClick={false} onClick={forks.reload}>
          {t('retry')}
        </DropdownMenuItem>
      </>
    );
  return forks.data?.threads.map((fork) => (
    <DropdownMenuItem
      key={fork.id}
      render={<ShellLink href={threadPath(fork.id)} />}
      className="flex-col items-start gap-0"
    >
      <span>{fork.title ?? tThread('untitled')}</span>
      <span className="text-muted-foreground text-xs leading-4">
        {format.dateTime(new Date(fork.createdAt), 'dayTime')}
      </span>
    </DropdownMenuItem>
  ));
}

function routeHeading(route: ShellRoute): ReactNode {
  if (route.kind === 'agent') return <AgentHeader />;
  if (route.kind === 'admin' || route.kind === 'library')
    return <PageHeaderSlot />;
  return undefined;
}

/** Fixed page headings: «Агенты» (agent-platform MC-4), «Мой доступ» (enterprise-access MC-7). */
const ROUTE_TITLES: Partial<Record<ShellRoute['kind'], 'agents' | 'account'>> =
  {
    agents: 'agents',
    account: 'account',
  };

/**
 * `/` → hidden. `/chat/<id>` → empty on TH-06 / TH-07; loading while the main view is switching or until
 * the open thread's list metadata is known (a direct link resolves before its item exists); then its title
 * or the pending placeholder.
 */
function useHeaderTitle(): HeaderTitle {
  const t = useTranslations('shell.thread');
  const { view, routeThreadId } = useMainViewState();
  const mainItem = useAuiState(selectMainItem);
  const remoteId = mainItem?.remoteId;
  const titleWaiting = useShellStatus(
    (s) => remoteId !== undefined && s.titleWaiting[remoteId] === true,
  );

  if (routeThreadId === undefined) return { kind: 'hidden' };
  if (view.kind === 'not-found' || view.kind === 'load-error')
    return { kind: 'empty' };
  if (
    view.kind === 'switching' ||
    mainItem === undefined ||
    remoteId !== routeThreadId
  )
    return { kind: 'loading' };
  const text = mainItem.title?.trim() ?? '';
  if (text !== '') return { kind: 'text', text, pending: false };
  return { kind: 'text', text: t('untitled'), pending: titleWaiting };
}

/** Whether the thread feed is scrolled away from its top; the viewport is owned by `Thread`. */
function useThreadScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Scroll events do not bubble: listen in the capture phase and keep only the feed's viewport.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.matches(THREAD_VIEWPORT_SELECTOR)
      ) {
        setScrolled(target.scrollTop > 0);
      }
    };
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  return scrolled;
}
