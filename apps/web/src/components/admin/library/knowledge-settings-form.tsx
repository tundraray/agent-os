'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { KnowledgeSettings } from '@agent-os/contracts';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { knowledgeSettingsRules, parseDecimal } from '@/lib/admin/form-rules';
import { cn } from '@/lib/utils';
import { AdminForm, AdminTextField, CAPTION } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

type KnowledgeSettingsValues = { limitTokens: string; lessonsEnabled: boolean };

const valuesOf = (settings: KnowledgeSettings): KnowledgeSettingsValues => ({
  limitTokens: String(settings.limitTokens),
  lessonsEnabled: settings.lessonsEnabled,
});

/** Called after `knowledgeSettingsRules` passed, so the text reads as a number. */
async function save({ limitTokens, lessonsEnabled }: KnowledgeSettingsValues): Promise<void> {
  const tokens = parseDecimal(limitTokens);
  if (tokens === null) throw new Error('Knowledge settings: the place was sent unchecked');
  await adminApi.knowledge.saveSettings({ limitTokens: tokens, lessonsEnabled });
}

/** AS-01 under «Системные»: the place for knowledge in a run and the lessons switch, one «Сохранить» for both. */
export function KnowledgeSettingsForm() {
  const t = useTranslations('admin.library.knowledge');
  const headingId = useId();
  const lessonsId = useId();
  const lessonsHintId = `${lessonsId}-hint`;
  const settings = useResource(adminApi.knowledge.settings, 'knowledge:settings');
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('title')}
      </h2>
      {data === undefined ? (
        <DataTable caption={t('title')} columns={[]} state={resourceTableState(settings, t('loadFailed'))} />
      ) : (
        // Every save moves `updatedAt`: the new read starts the form from the values the server now holds.
        <AdminForm<KnowledgeSettingsValues>
          key={data.updatedAt ?? 'defaults'}
          variant="page"
          initialValues={valuesOf(data)}
          validate={knowledgeSettingsRules}
          hasChange={(values) => {
            const saved = valuesOf(data);
            return values.limitTokens !== saved.limitTokens || values.lessonsEnabled !== saved.lessonsEnabled;
          }}
          onSubmit={save}
          submitLabel={t('save')}
          savedText={t('saved')}
          onSaved={settings.reload}
          logEvent="admin: knowledge settings"
        >
          {(form) => (
            <>
              <AdminTextField
                {...form.field('limitTokens')}
                label={t('limitTokens')}
                hint={t('limitTokensHint')}
                inputMode="numeric"
                inputClassName="w-24"
                value={form.values.limitTokens}
                onChange={(value) => form.set('limitTokens', value)}
              />
              <div className="flex flex-col gap-1.5">
                <Field orientation="horizontal" className="gap-2">
                  <Checkbox
                    id={lessonsId}
                    checked={form.values.lessonsEnabled}
                    // The Base UI checkbox is not a native field: the form's disabled fieldset does not reach it.
                    disabled={form.saving}
                    aria-describedby={lessonsHintId}
                    onCheckedChange={(checked) => form.set('lessonsEnabled', checked)}
                  />
                  <FieldLabel htmlFor={lessonsId} className="text-data font-normal text-foreground">
                    {t('lessonsEnabled')}
                  </FieldLabel>
                </Field>
                <FieldDescription id={lessonsHintId} className={cn(CAPTION, 'pl-6 text-muted-foreground')}>
                  {t('lessonsEnabledHint')}
                </FieldDescription>
              </div>
            </>
          )}
        </AdminForm>
      )}
    </section>
  );
}
