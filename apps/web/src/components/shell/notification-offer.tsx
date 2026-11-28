'use client';

import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { offerShown } from '@/lib/notifications/notifications-store';
import { useShellServices } from './shell-actions';
import { useEnableNotifications } from './use-enable-notifications';
import { USER_MENU_ATTRIBUTE } from './user-menu';

const focusUserMenu = (): void =>
  document.querySelector<HTMLElement>(`[${USER_MENU_ATTRIBUTE}]`)?.focus();

/**
 * LF-03 of the live-feed UXRD: the offer above the user block at the bottom of the sidebar and of the drawer, not in
 * the icon strip (the caller leaves it out there). «Включить уведомления» asks the browser, «×» hides the offer in
 * this browser; after the browser's answer the offer is gone and focus moves to the user block (SB-11). Its
 * appearance is not announced: it is not urgent and stands in the sidebar's Tab order.
 */
export function NotificationOffer() {
  const t = useTranslations('shell.notifications');
  const { notifications, currentUser } = useShellServices();
  const level = useStore(currentUser, (state) => state.user?.notificationLevel);
  const shown = useStore(notifications, (state) => offerShown(state, level));
  const askBrowser = useEnableNotifications();

  if (!shown) return null;

  async function enable(): Promise<void> {
    await askBrowser();
    focusUserMenu();
  }

  return (
    <div className="relative mx-2 flex flex-col items-start gap-2 rounded-md border border-border bg-sidebar p-3 pr-9">
      <p className="text-xs leading-4">{t('offer')}</p>
      <Button variant="outline" size="sm" onClick={() => void enable()}>
        {t('enable')}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-2 right-2 pointer-coarse:size-11 pointer-coarse:top-0 pointer-coarse:right-0"
        aria-label={t('dismiss')}
        onClick={() => {
          notifications.dismissOffer();
          focusUserMenu();
        }}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}
