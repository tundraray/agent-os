'use client';

import { useId } from 'react';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { librarySettingsRules, parseDecimal } from '@/lib/admin/form-rules';
import { AdminForm, AdminTextField } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

/** Not in the UXRD; «Сохранить» — MC-20. */
const TEXT = {
  title: 'Настройки новых записей',
  defaultMaxTurns: 'Лимит ходов для новой записи',
  hint: 'Это число подставляется в «Максимум шагов» нового агента или workflow. В каждой записи его можно изменить; уже созданные записи не меняются.',
  save: 'Сохранить',
  saved: 'Лимит ходов сохранён',
  loadFailed: 'Не удалось загрузить настройки',
} as const;

/** Called after `librarySettingsRules` passed, so the text reads as a number. */
async function save({ defaultMaxTurns }: { defaultMaxTurns: string }): Promise<void> {
  const turns = parseDecimal(defaultMaxTurns);
  if (turns === null) throw new Error('Library settings: the limit was sent unchecked');
  await adminApi.library.saveSettings({ defaultMaxTurns: turns });
}

/** The library's settings under «Системные»: «Максимум шагов» a new agent or workflow starts with. */
export function LibrarySettingsForm() {
  const headingId = useId();
  const settings = useResource(adminApi.library.settings, 'library:settings');
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {TEXT.title}
      </h2>
      {data === undefined ? (
        <DataTable caption={TEXT.title} columns={[]} state={resourceTableState(settings, TEXT.loadFailed)} />
      ) : (
        // Every save moves `updatedAt`: the new read starts the form from the value the server now holds.
        <AdminForm
          key={data.updatedAt ?? 'defaults'}
          variant="page"
          initialValues={{ defaultMaxTurns: String(data.defaultMaxTurns) }}
          validate={librarySettingsRules}
          onSubmit={save}
          submitLabel={TEXT.save}
          savedText={TEXT.saved}
          onSaved={settings.reload}
          logEvent="admin: library settings"
        >
          {(form) => (
            <AdminTextField
              {...form.field('defaultMaxTurns')}
              label={TEXT.defaultMaxTurns}
              hint={TEXT.hint}
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
