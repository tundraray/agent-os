'use client';

import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { MenuIcon } from 'lucide-react';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { AppSidebar, MENU_BUTTON_ATTRIBUTE } from './app-sidebar';
import { ChatRuntimeProvider } from './chat-runtime-provider';

type ChatShellProps = {
  /** Sidebar state read by the `(chat)` layout from the `sidebar_state` cookie: the first frame matches it. */
  defaultSidebarOpen: boolean;
  children: ReactNode;
};

/** SH-01: sidebar (built-in or drawer) and the main area, on the full height of the dynamic viewport. */
export function ChatShell({ defaultSidebarOpen, children }: ChatShellProps) {
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen} className="h-dvh overflow-hidden">
      <ChatRuntimeProvider>
        <SkipToComposerLink />
        <AppSidebar />
        <SidebarInset className="min-h-0 min-w-0">
          <SidebarToggleBar />
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
          {children}
        </SidebarInset>
        <CloseDrawerOnDesktop />
      </ChatRuntimeProvider>
    </SidebarProvider>
  );
}

const focusComposer = (event: MouseEvent<HTMLAnchorElement>): void => {
  event.preventDefault();
  document.querySelector<HTMLElement>('[data-shell-focus="composer"]')?.focus();
};

/** First stop in the Tab order; visible only while focused. */
function SkipToComposerLink() {
  return (
    <a
      href="#composer"
      onClick={focusComposer}
      className="bg-background text-foreground focus-visible:ring-ring sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus-visible:ring-3"
    >
      Перейти к сообщению
    </a>
  );
}

/** HD-02 until the header (HD-01) lands: «Меню» opens the drawer below 768 px, «Боковая панель» toggles above. */
function SidebarToggleBar() {
  const { open, toggleSidebar } = useSidebar();
  const menuButtonProps = { [MENU_BUTTON_ATTRIBUTE]: '' };

  return (
    <div className="flex h-(--header-height) shrink-0 items-center px-2 md:px-3">
      <Button
        {...menuButtonProps}
        variant="ghost"
        size="icon"
        className="size-11 md:hidden"
        aria-label="Меню"
        aria-haspopup="dialog"
        onClick={toggleSidebar}
      >
        <MenuIcon aria-hidden />
      </Button>
      <SidebarTrigger
        className="hidden md:inline-flex"
        aria-expanded={open}
        aria-keyshortcuts="Control+B Meta+B"
      />
    </div>
  );
}

/** Crossing to ≥ 768 px closes the drawer, so it does not reopen by itself when the window narrows again. */
function CloseDrawerOnDesktop() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (!isMobile && openMobile) setOpenMobile(false);
  }, [isMobile, openMobile, setOpenMobile]);
  return null;
}
