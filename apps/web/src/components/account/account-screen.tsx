'use client';

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { CurrentUserStore } from '@/lib/auth/current-user';
import { focusShellTarget } from '@/lib/focus';
import { THEME_SECTION_ID } from '@/lib/shell-route';
import { ConnectionsSection } from './connections-section';
import { LanguageSection } from './language-section';
import { MemorySection } from './memory-section';
import { ModelsSection } from './models-section';
import { NotificationsSection } from './notifications-section';
import { PasswordSection } from './password-section';
import { ThemeSection } from './theme-section';

/**
 * Screen 3 «Мой доступ» (UXRD): sections one under another in the feed column (chat-shell UXRD, D-01);
 * the title is the shell header's `h1`. The parts `mcp-connect` and `access` add MA-01 and MA-02 above
 * MA-03; the theming section TP-01, the i18n section LN-01 and the live-feed section LF-04 come last. The store comes from the shell: one read of the employee per
 * page load.
 */
export function AccountScreen({
  currentUser,
}: {
  currentUser: CurrentUserStore;
}) {
  const user = useStore(currentUser, (state) => state.user);

  useEffect(() => {
    currentUser.load();
  }, [currentUser]);

  // UXRD «Порядок фокуса»: after the move to the page, focus lands on its title; the menu's «Тема: …» leads
  // to the checked theme card instead (theming UXRD, TP-02), and the focus scrolls the page to it.
  useEffect(() => {
    focusShellTarget(
      window.location.hash === `#${THEME_SECTION_ID}`
        ? 'theme-picker'
        : 'page-title',
    );
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-6 px-4 py-4 md:py-6">
        <ConnectionsSection />
        <ModelsSection />
        <MemorySection />
        <PasswordSection hasPassword={user?.hasPassword === true} />
        <ThemeSection />
        <LanguageSection currentUser={currentUser} />
        <NotificationsSection currentUser={currentUser} />
      </div>
    </div>
  );
}
