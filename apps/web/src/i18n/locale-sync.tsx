'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useStore } from 'zustand';
import type { CurrentUserStore } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';

/**
 * DC-3: the page was drawn from a stale `aos_locale` (the choice changed on another device). `GET
 * /api/auth/me` has already set the fresh cookie, so once the employee is read and the choice differs from
 * the page language, the server tree is redrawn — once per shell mount (KD-3). Only that first read
 * decides: a later change of the store is the language section's own save, which refreshes by itself.
 */
export function LocaleSync({ currentUser }: { currentUser: CurrentUserStore }) {
  const router = useRouter();
  const locale = useLocale();
  const user = useStore(currentUser, (state) => state.user);
  const decided = useRef(false);

  useEffect(() => {
    currentUser.load();
  }, [currentUser]);

  useEffect(() => {
    if (decided.current || user === null) return;
    decided.current = true;
    if (user.language === null || user.language === locale) return;
    logger.info('locale: profile choice differs from the page, refreshing', { page: locale, chosen: user.language });
    router.refresh();
  }, [user, locale, router]);

  return null;
}
