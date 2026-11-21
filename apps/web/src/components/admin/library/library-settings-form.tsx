'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { librarySettingsRules, parseDecimal } from '@/lib/admin/form-rules';
import { AdminForm, AdminTextField } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

/** Called after `librarySettingsRules` passed, so the text reads as a number. */
async function save({ defaultMaxTurns }: { defaultMaxTurns: string }): Promise<void> {
  const turns = parseDecimal(defaultMaxTurns);
  if (turns === null) throw new Error('Library settings: the limit was sent unchecked');
  await adminApi.library.saveSettings({ defaultMaxTurns: turns });
}

/** The library's settings under «Системные»: «Максимум шагов» a new agent or workflow starts with. */
export function LibrarySettingsForm() {
  const t = useTranslations('admin.library.settings');
  const headingId = useId();
  const settings = useResource(adminApi.library.settings, 'library:settings');
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('title')}
      </h2>
      {data === undefined ? (
        <DataTable caption={t('title')} columns={[]} state={resourceTableState(settings, t('loadFailed'))} />
      ) : (
        // Every save moves `updatedAt`: the new read starts the form from the value the server now holds.
        <AdminForm
          key={data.updatedAt ?? 'defaults'}
          variant="page"
          initialValues={{ defaultMaxTurns: String(data.defaultMaxTurns) }}
          validate={librarySettingsRules}
          onSubmit={save}
          submitLabel={t('save')}
          savedText={t('saved')}
          onSaved={settings.reload}
          logEvent="admin: library settings"
        >
          {(form) => (
            <AdminTextField
              {...form.field('defaultMaxTurns')}
              label={t('defaultMaxTurns')}
              hint={t('hint')}
              inputMode="numeric"
              inputClassName="w-24"
              value={form.values.defaultMaxTurns}
              onChange={(value) => form.set('defaultMaxTurns', value)}
            />
          )}
        </AdminForm>
      )}
    </section>
  );
}
