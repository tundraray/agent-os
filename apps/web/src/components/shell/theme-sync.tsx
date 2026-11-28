'use client';

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { effectiveTheme, type CurrentUserStore } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';
import { chooseTheme, readTheme } from '@/lib/theme';

/**
 * Theming KD-4: the page was painted from a stale `aos_theme` (the theme changed on another device or in the
 * organisation). Once the employee is read and the effective theme differs from the page's, it is applied through
 * `chooseTheme`, which also renews the cookie — once per shell mount. Only that first read decides: a later change
 * of the store is a save of the theme section or the «Оформление» section, which apply the theme themselves.
 */
export function ThemeSync({ currentUser }: { currentUser: CurrentUserStore }) {
  const user = useStore(currentUser, (state) => state.user);
  const decided = useRef(false);

  useEffect(() => {
    currentUser.load();
  }, [currentUser]);

  useEffect(() => {
    if (decided.current || user === null) return;
    decided.current = true;
    const theme = effectiveTheme(user);
    const page = readTheme();
    if (theme === page) return;
    logger.info('theme: profile theme differs from the page, applying', {
      page,
      theme,
    });
    chooseTheme(theme);
  }, [user]);

  return null;
}
