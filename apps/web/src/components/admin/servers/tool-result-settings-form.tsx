'use client';

import { useId } from 'react';
import type { ToolResultSettings } from '@agent-os/contracts';
import { useResource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  toolResultSettingsBodyOf,
  toolResultSettingsRules,
  type ToolResultSettingsValues,
} from '@/lib/admin/form-rules';
import { AdminForm, AdminTextField } from '../admin-form';
import { DataTable, resourceTableState } from '../data-table';

/** tool-result-reading R-5 (no UXRD): the texts follow «Самообучение workflow». */
const TEXT = {
  title: 'Большие результаты инструментов',
  storeFromChars: 'Заменять ответ ссылкой, если он длиннее, символов',
  storeFromCharsHint:
    'Ответ MCP-инструмента длиннее этого агент получает ссылкой с началом ответа, а остальное дочитывает по частям.',
  previewChars: 'Начало ответа в ссылке, символов',
  previewCharsHint: 'Сколько первых символов ответа агент видит сразу. Меньше длины, с которой ответ заменяется ссылкой.',
  readMaxTokens: 'Агент дочитывает за раз, токенов',
  readMaxTokensHint: 'Сколько агент получает за одно чтение или один поиск по сохранённому ответу.',
  save: 'Сохранить',
  saved: 'Настройки результатов сохранены',
  loadFailed: 'Не удалось загрузить настройки',
} as const;

const FIELDS = [
  { key: 'storeFromChars', label: TEXT.storeFromChars, hint: TEXT.storeFromCharsHint },
  { key: 'previewChars', label: TEXT.previewChars, hint: TEXT.previewCharsHint },
  { key: 'readMaxTokens', label: TEXT.readMaxTokens, hint: TEXT.readMaxTokensHint },
] as const;

const valuesOf = (settings: ToolResultSettings): ToolResultSettingsValues => ({
  storeFromChars: String(settings.storeFromChars),
  previewChars: String(settings.previewChars),
  readMaxTokens: String(settings.readMaxTokens),
});

/** Called after `toolResultSettingsRules` passed, so every text reads as a number. */
async function save(values: ToolResultSettingsValues): Promise<void> {
  await adminApi.toolResults.saveSettings(toolResultSettingsBodyOf(values));
}

/**
 * Under the «MCP-серверы» list: when an MCP answer reaches the agent as a reference, its preview and one
 * reading page, one «Сохранить» for the three. The next MCP call reads the saved row.
 */
export function ToolResultSettingsForm() {
  const headingId = useId();
  const settings = useResource(adminApi.toolResults.settings, 'tool-results:settings');
  const data = settings.data;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {TEXT.title}
      </h2>
      {data === undefined ? (
        <DataTable caption={TEXT.title} columns={[]} state={resourceTableState(settings, TEXT.loadFailed)} />
      ) : (
        // Every save moves `updatedAt`: the new read starts the form from the values the server now holds.
        <AdminForm<ToolResultSettingsValues>
          key={data.updatedAt ?? 'defaults'}
          variant="page"
          initialValues={valuesOf(data)}
          validate={toolResultSettingsRules}
          hasChange={(values) => {
            const saved = valuesOf(data);
            return FIELDS.some(({ key }) => values[key] !== saved[key]);
          }}
          onSubmit={save}
          submitLabel={TEXT.save}
          savedText={TEXT.saved}
          onSaved={settings.reload}
          logEvent="admin: tool result settings"
        >
          {(form) => (
            <>
              {FIELDS.map(({ key, label, hint }) => (
                <AdminTextField
                  key={key}
                  {...form.field(key)}
                  label={label}
                  hint={hint}
                  inputMode="numeric"
                  inputClassName="w-28"
                  value={form.values[key]}
                  onChange={(value) => form.set(key, value)}
                />
              ))}
            </>
          )}
        </AdminForm>
      )}
    </section>
  );
}
