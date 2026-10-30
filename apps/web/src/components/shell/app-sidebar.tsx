'use client';

import { useRef, type MouseEvent } from 'react';
import Link from 'next/link';
import { DiamondIcon, SquarePenIcon, XIcon } from 'lucide-react';
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
import { useShortcutLabel } from '@/hooks/use-global-shortcuts';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';
import { useShellActions } from './shell-actions';
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
 * The thread list mounts inside `nav «История бесед»`; the icon strip shows no list.
 */
export function AppSidebar() {
  const { newChat } = useShellActions();
  const { isMobile, state, setOpenMobile } = useSidebar();
  const newChatRef = useRef<HTMLButtonElement>(null);
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

  const onHistoryClick = (event: MouseEvent<HTMLElement>): void => {
    if (isMobile && event.target instanceof Element && event.target.closest(`[${THREAD_LINK_ATTRIBUTE}]`) !== null) {
      actionOwnsFocus.current = true;
    }
  };

  return (
    <Sidebar id={SIDEBAR_ID} collapsible="icon" initialFocus={newChatRef} finalFocus={finalFocus}>
      <SidebarHeader className={cn('gap-1', isMobile && 'pt-[max(0.5rem,env(safe-area-inset-top))]')}>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            <SidebarMenuButton
              tooltip={isMobile ? undefined : 'Agent OS'}
              className={cn('font-semibold', isMobile ? 'h-11' : 'h-10')}
              render={<Link href="/" />}
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
          <SidebarMenuItem>
            <SidebarMenuButton
              ref={newChatRef}
              variant="outline"
              tooltip={isMobile ? undefined : `Новый чат · ${newChatShortcut}`}
              aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
              className={cn(pressable, isMobile ? 'h-11' : 'h-9')}
              onClick={() => {
                if (isMobile) {
                  actionOwnsFocus.current = true;
                  setOpenMobile(false);
                }
                newChat('button');
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
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {!isStrip && (
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
