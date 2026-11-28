'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import {
  ORGANIZATION_CHOICE,
  ThemePicker,
  type ThemeChoice,
} from '@/components/theme-picker';
import { useShellServices } from '@/components/shell/shell-actions';
import { describeApiError } from '@/lib/api/api-request';
import { authApi } from '@/lib/auth/auth-api';
import { effectiveTheme, type CurrentUserStore } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';
import { THEME_SECTION_ID } from '@/lib/shell-route';
import { chooseTheme } from '@/lib/theme';

/**
 * TP-01 of the theming UXRD, the variant «Сотрудник» (theme-picker): the checked card is the employee's own theme
 * of the store, «Как в организации» while it is empty (UXRD KD-4). A choice applies its theme to the page at once and
 * is saved in the background, each choice by its own request (KD-5); after a 204 the store knows the new own theme.
 * A refusal returns the page and the check to the saved theme and shows MC-6. It is the target of the menu's
 * «Тема: …».
 */
export function ThemeSection({
  currentUser,
}: {
  currentUser: CurrentUserStore;
}) {
  const t = useTranslations('account.theme');
  const { announcer } = useShellServices();
  const headingId = useId();
  const user = useStore(currentUser, (state) => state.user);
  /** The last choice while its save is in flight. */
  const [pending, setPending] = useState<ThemeChoice | null>(null);
  const [failed, setFailed] = useState(false);
  const latestChoice = useRef(0);

  if (user === null) return null;

  const saved: ThemeChoice = user.theme ?? ORGANIZATION_CHOICE;

  const choose = async (choice: ThemeChoice): Promise<void> => {
    const own = choice === ORGANIZATION_CHOICE ? null : choice;
    const applied = effectiveTheme({
      theme: own,
      organizationTheme: user.organizationTheme,
    });
    const order = ++latestChoice.current;
    setPending(choice);
    setFailed(false);
    chooseTheme(applied);
    announcer
      .getState()
      .announce('account.theme.announced', { theme: t(`names.${applied}`) });
    try {
      await authApi.saveTheme(own);
      logger.info('account: theme saved', { theme: own });
      currentUser.setTheme(own);
      if (order === latestChoice.current) setPending(null);
    } catch (cause) {
      logger.error('account: theme save failed', {
        theme: own,
        ...describeApiError(cause),
      });
      const stored = currentUser.getState().user;
      if (stored !== null) chooseTheme(effectiveTheme(stored));
      setPending(null);
      setFailed(true);
    }
  };

  return (
    <section
      id={THEME_SECTION_ID}
      aria-labelledby={headingId}
      className="flex max-w-160 flex-col gap-4"
    >
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('heading')}
      </h2>
      <ThemePicker
        labelledBy={headingId}
        checked={pending ?? saved}
        organizationTheme={user.organizationTheme}
        onChoose={(choice) => void choose(choice)}
        hint={t('hint')}
        error={failed ? t('saveFailed') : null}
      />
    </section>
  );
}
