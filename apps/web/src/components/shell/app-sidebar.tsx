'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { DiamondIcon, SquarePenIcon, XIcon } from 'lucide-react';
import { pressable } from '@/components/surfaces';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useShellActions } from './shell-actions';

/** Marks the header button that opens the mobile drawer; focus returns to it when the drawer closes. */
export const MENU_BUTTON_ATTRIBUTE = 'data-shell-menu-button';

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
  const isStrip = !isMobile && state === 'collapsed';

  return (
    <Sidebar collapsible="icon" initialFocus={newChatRef} finalFocus={focusMenuButton}>
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
              tooltip={isMobile ? undefined : 'Новый чат'}
              aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
              className={cn(pressable, isMobile ? 'h-11' : 'h-9')}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                newChat('button');
              }}
            >
              <SquarePenIcon aria-hidden />
              <span>Новый чат</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {!isStrip && <nav aria-label="История бесед" className="flex min-h-0 flex-1 flex-col" />}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
