'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  parseDecimal,
  selfLearningSettingsRules,
  type SelfLearningSettingsValues,
} from '@/lib/admin/form-rules';
import { AdminForm, AdminTextField } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

/** Called after `selfLearningSettingsRules` passed, so both texts read as numbers. */
async function save({
  memoryIndexTokens,
  trainingCapUsd,
}: SelfLearningSettingsValues): Promise<void> {
  const tokens = parseDecimal(memoryIndexTokens);
  const cap = parseDecimal(trainingCapUsd);
  if (tokens === null || cap === null)
    throw new Error('Self-learning settings: a value was sent unchecked');
  await adminApi.selfLearning.saveSettings({
    memoryIndexTokens: tokens,
    trainingCapUsd: cap,
  });
}

/** AS-01 under «Системные»: the size of the memory index in every step of a run and the spend cap of one training. */
export function SelfLearningSettingsForm() {
  const t = useTranslations('admin.library.selfLearning');
  const headingId = useId();
  const settings = useResource(
    adminApi.selfLearning.settings,
    'self-learning:settings',
  );
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('title')}
      </h2>
      {data === undefined ? (
        <DataTable
          caption={t('title')}
          columns={[]}
          state={resourceTableState(settings, t('loadFailed'))}
        />
      ) : (
        // Every save moves `updatedAt`: the new read starts the form from the values the server now holds.
        <AdminForm<SelfLearningSettingsValues>
          key={data.updatedAt ?? 'defaults'}
          variant="page"
          initialValues={{
            memoryIndexTokens: String(data.memoryIndexTokens),
            trainingCapUsd: String(data.trainingCapUsd),
          }}
          validate={selfLearningSettingsRules}
          hasChange={(values) =>
            values.memoryIndexTokens !== String(data.memoryIndexTokens) ||
            values.trainingCapUsd !== String(data.trainingCapUsd)
          }
          onSubmit={save}
          submitLabel={t('save')}
          savedText={t('saved')}
          onSaved={settings.reload}
          logEvent="admin: self-learning settings"
        >
          {(form) => (
            <>
              <AdminTextField
                {...form.field('memoryIndexTokens')}
                label={t('memoryIndexTokens')}
                hint={t('memoryIndexTokensHint')}
                inputMode="numeric"
                inputClassName="w-24"
                value={form.values.memoryIndexTokens}
                onChange={(value) => form.set('memoryIndexTokens', value)}
              />
              <AdminTextField
                {...form.field('trainingCapUsd')}
                label={t('trainingCapUsd')}
                hint={t('trainingCapUsdHint')}
                inputMode="decimal"
                inputClassName="w-24"
                value={form.values.trainingCapUsd}
                onChange={(value) => form.set('trainingCapUsd', value)}
              />
            </>
          )}
        </AdminForm>
      )}
    </section>
  );
}
