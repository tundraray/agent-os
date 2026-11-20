'use client';

import { useRef, type MouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import { BotIcon, DiamondIcon, HandIcon, LibraryBigIcon, SquarePenIcon, XIcon, type LucideIcon } from 'lucide-react';
import { pressable } from '@/components/surfaces';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAdminRight } from '@/components/admin/admin-gate';
import { AdminSidebarNav } from '@/components/admin/admin-sidebar-nav';
import { useShortcutLabel } from '@/hooks/use-global-shortcuts';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useAwaitingCount } from '@/lib/agents/awaiting-count';
import { focusShellTarget } from '@/lib/focus';
import { AGENTS_PATH, libraryPath, parseShellRoute, type ShellRoute } from '@/lib/shell-route';
import { cn } from '@/lib/utils';
import { useShellActions } from './shell-actions';
import { ShellLink } from './shell-link';
import { THREAD_LINK_ATTRIBUTE } from './thread-history-item';
import { ThreadHistoryList } from './thread-history-list';
import { UserMenu } from './user-menu';

/**
 * Marks the header button that opens the mobile drawer; focus returns to it when the drawer is dismissed
 * (Esc, «×», backdrop, swipe).
 */
export const MENU_BUTTON_ATTRIBUTE = 'data-shell-menu-button';

/** `id` of SB-01, the element the header's «Боковая панель» button controls (rendered expanded and collapsed). */
export const SIDEBAR_ID = 'shell-sidebar';

const focusMenuButton = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[${MENU_BUTTON_ATTRIBUTE}]`);

/**
 * SB-01: the built-in sidebar (256 px or the 48 px icon strip) at ≥ 768 px and the modal drawer SB-13 below.
 * The thread list mounts inside `nav «История бесед»`; the icon strip shows no list. On a panel address the
 * panel's sections take the place of «Новый чат», «Агенты», «Библиотека» and the list, unless the employee has
 * no right there (AD-02 keeps the ordinary sidebar).
 */
export function AppSidebar() {
  const { newChat } = useShellActions();
  const { isMobile, state, setOpenMobile } = useSidebar();
  const route = parseShellRoute(usePathname());
  const adminRight = useAdminRight();
  const panel = route.kind === 'admin' && adminRight !== 'denied';
  const newChatRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLAnchorElement>(null);
  // Set when the drawer closes because a thread or SB-03 was picked: that action focuses its own target
  // (HD-03 or the composer, UXRD 7.4), so the drawer must not pull focus back to «Меню» after its exit transition.
  const actionOwnsFocus = useRef(false);
  const isStrip = !isMobile && state === 'collapsed';
  const newChatShortcut = useShortcutLabel('new-chat');
  // SB-03 shows its shortcut inline only where a keyboard is likely: ≥ 1024 px with a fine pointer.
  const showShortcutHint = useMediaQuery('(min-width: 1024px) and (pointer: fine)') && !isMobile && !isStrip;

  const finalFocus = (): HTMLElement | false | null => {
    if (!actionOwnsFocus.current) return focusMenuButton();
    actionOwnsFocus.current = false;
    return false;
  };

  // A pick that focuses its own target (an agent page's or a panel section's h1) closes the drawer.
  const onMobilePick = (): void => {
    actionOwnsFocus.current = true;
    setOpenMobile(false);
  };

  const onHistoryClick = (event: MouseEvent<HTMLElement>): void => {
    if (isMobile && event.target instanceof Element && event.target.closest(`[${THREAD_LINK_ATTRIBUTE}]`) !== null) {
      actionOwnsFocus.current = true;
    }
  };

  return (
    <Sidebar id={SIDEBAR_ID} collapsible="icon" initialFocus={panel ? backRef : newChatRef} finalFocus={finalFocus}>
      <SidebarHeader className={cn('gap-1', isMobile && 'pt-[max(0.5rem,env(safe-area-inset-top))]')}>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            <SidebarMenuButton
              tooltip={isMobile ? undefined : 'Agent OS'}
              className={cn('font-semibold', isMobile ? 'h-11' : 'h-10')}
              render={<ShellLink href="/" />}
            >
              <DiamondIcon aria-hidden />
              <span>Agent OS</span>
            </SidebarMenuButton>
            {isMobile && (
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Закрыть меню"
                onClick={() => setOpenMobile(false)}
              >
                <XIcon aria-hidden />
              </Button>
            )}
          </SidebarMenuItem>
          {!panel && (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton
                  ref={newChatRef}
                  variant="outline"
                  tooltip={isMobile ? undefined : `Новый чат · ${newChatShortcut}`}
                  aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
                  className={cn(pressable, isMobile ? 'h-11' : 'h-9')}
                  onClick={() => {
                    if (isMobile) onMobilePick();
                    newChat();
                  }}
                >
                  <SquarePenIcon aria-hidden />
                  <span>Новый чат</span>
                  {showShortcutHint && (
                    <span aria-hidden className="text-muted-foreground ml-auto text-xs">
                      {newChatShortcut.replaceAll('+', ' ')}
                    </span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SectionNavItems route={route} onMobilePick={onMobilePick} />
            </>
          )}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {panel && (
          <nav aria-label="Панель" className="p-2">
            <AdminSidebarNav loading={adminRight === 'unknown'} backRef={backRef} onMobilePick={onMobilePick} />
          </nav>
        )}
        {!panel && !isStrip && (
          <nav aria-label="История бесед" className="flex min-h-0 flex-1 flex-col" onClick={onHistoryClick}>
            <ThreadHistoryList />
          </nav>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The employee's sections; mounted off the panel only, so the panel never reads the awaiting count. */
function SectionNavItems({ route, onMobilePick }: { route: ShellRoute; onMobilePick: () => void }) {
  const awaiting = useAwaitingCount();
  return (
    <>
      <SectionNavItem
        href={AGENTS_PATH}
        label="Агенты"
        icon={BotIcon}
        isActive={route.kind === 'agents' || route.kind === 'agent'}
        awaiting={awaiting}
        onMobilePick={onMobilePick}
      />
      <SectionNavItem
        href={libraryPath()}
        label="Библиотека"
        icon={LibraryBigIcon}
        isActive={route.kind === 'library'}
        onMobilePick={onMobilePick}
      />
    </>
  );
}

type SectionNavItemProps = {
  href: string;
  /** The item's visible name (agent-platform MC-1, custom-agents MC-1). */
  label: string;
  icon: LucideIcon;
  /** Selected on every page of its section, like the active thread (SB-06). */
  isActive: boolean;
  /** Decisions waiting (NV-01, «Агенты» only). */
  awaiting?: number;
  onMobilePick: () => void;
};

/**
 * A section of the employee's sidebar under SB-03: «Агенты» (NV-01) and «Библиотека» (LB-01).
 * With decisions waiting: `Hand` and the number in `--approval` on the right, in the strip a 6 px dot;
 * the number swaps without animation.
 */
function SectionNavItem({ href, label, icon: Icon, isActive, awaiting = 0, onMobilePick }: SectionNavItemProps) {
  const { isMobile, state } = useSidebar();
  const isStrip = !isMobile && state === 'collapsed';
  const name = awaiting > 0 ? `${label}, ждут решения: ${awaiting}` : label;

  // As a thread link (UXRD 7.4): a tap or a pick from the drawer focuses the page h1; a fine pointer leaves focus be.
  const onClick = (): void => {
    if (!isMobile) return;
    onMobilePick();
    focusShellTarget('page-title');
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        tooltip={isMobile ? undefined : name}
        aria-label={awaiting > 0 ? name : undefined}
        className={cn(
          'pointer-coarse:h-11',
          isMobile ? 'h-11' : 'h-9',
          // Selected marker as on SB-06: the --sidebar-accent background alone is below 3:1.
          'relative data-active:before:absolute data-active:before:inset-y-2 data-active:before:left-0 data-active:before:w-0.75 data-active:before:rounded-full data-active:before:bg-sidebar-primary',
        )}
        render={<ShellLink href={href} aria-current={isActive ? 'page' : undefined} onClick={onClick} />}
      >
        <span aria-hidden className="relative flex shrink-0">
          <Icon />
          {isStrip && awaiting > 0 && (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-approval" />
          )}
        </span>
        <span className="flex-1 truncate">{label}</span>
        {!isStrip && awaiting > 0 && (
          <span aria-hidden className="flex shrink-0 items-center gap-1 text-approval tabular-nums">
            <HandIcon />
            {awaiting}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
