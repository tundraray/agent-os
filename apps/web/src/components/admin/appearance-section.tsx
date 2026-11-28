'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ThemeId } from '@agent-os/contracts';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { ThemePicker, type ThemeChoice } from '@/components/theme-picker';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { logger } from '@/lib/logger';
import { chooseTheme, isThemeId } from '@/lib/theme';
import { useAdminTitles } from './admin-header';
import { describeRefusal } from './admin-form';
import { DataTable, resourceTableState } from './data-table';

const LOG_EVENT = 'admin: appearance settings';

/**
 * TP-03 of the theming UXRD, «Оформление»: the organisation's theme with the theme-picker's variant «Организация»,
 * saved on choice (Flow 4). After the answer — «Сохранено», the organisation's theme in the store and, while the
 * administrator has no own theme, on his page too; a refusal returns the check and shows MC-8 with the server's words.
 */
export function AppearanceSection() {
  const titles = useAdminTitles();
  const t = useTranslations('admin.appearance');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const { currentUser } = useShellServices();
  const headingId = useId();
  const settings = useResource(
    adminApi.appearance.settings,
    'admin:appearance',
  );
  /** The theme the last answered save left on the server, over the first read. */
  const [saved, setSaved] = useState<ThemeId | null>(null);
  /** The last choice while its save is in flight. */
  const [pending, setPending] = useState<ThemeId | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const latestChoice = useRef(0);
  const data = settings.data;

  const choose = async (theme: ThemeId): Promise<void> => {
    const order = ++latestChoice.current;
    setPending(theme);
    setError(null);
    try {
      const after = await adminApi.appearance.saveSettings(theme);
      logger.info(`${LOG_EVENT}: saved`, { theme: after.theme });
      toast.success(tCommon('saved'));
      currentUser.setOrganizationTheme(after.theme);
      if (currentUser.getState().user?.theme === null) chooseTheme(after.theme);
      setSaved(after.theme);
      if (order === latestChoice.current) setPending(null);
    } catch (cause) {
      setPending(null);
      const refusal = describeRefusal(tErrors, cause, { logEvent: LOG_EVENT });
      if (refusal !== null) setError(refusal.text);
    }
  };

  return (
    <>
      <PageHeader area={titles.panel} title={titles.section('appearance')} />
      <section
        aria-labelledby={headingId}
        className="flex max-w-160 flex-col gap-3"
      >
        <h2 id={headingId} className="text-base leading-6 font-semibold">
          {t('heading')}
        </h2>
        {data === undefined ? (
          <DataTable
            caption={t('heading')}
            columns={[]}
            state={resourceTableState(settings, t('loadFailed'))}
          />
        ) : (
          <ThemePicker
            labelledBy={headingId}
            checked={pending ?? saved ?? data.theme}
            onChoose={(choice: ThemeChoice) => {
              if (isThemeId(choice)) void choose(choice);
            }}
            hint={t('hint')}
            error={error}
          />
        )}
      </section>
    </>
  );
}
