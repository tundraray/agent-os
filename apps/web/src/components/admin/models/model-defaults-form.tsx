'use client';

import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { CatalogModel, ModelDefaults, ModelProviderView, ModelPurpose } from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import type { Resource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import {
  modelOptions,
  modelUnavailableReason,
  unavailableShortText,
  type ModelOption,
} from '@/lib/admin/model-providers';
import { AdminForm, AdminSelectField, type AdminSelectOption } from '../admin-form';
import { DataTable, type DataTableState } from '../data-table';
import type { ModelsTranslator } from '@/lib/i18n/messages';

/** Constant ids, so «Выбрать по умолчанию» of the model dialog can move focus into the field of its purpose. */
export const MODEL_DEFAULT_FIELD_ID = {
  chat: 'model-default-chat',
  embedding: 'model-default-embedding',
} as const satisfies Record<ModelPurpose, string>;

type DefaultsValues = { chat: string | null; embedding: string | null };

/** The «Не выбрана» option; a model id always holds «/», so it never collides with one. */
const NONE = 'none';

/** The open list: the title, then the provider (and the dimension), and the badge of a model that does not work (MC-8). */
function optionContent(t: ModelsTranslator, option: ModelOption) {
  const details = option.dimensions === null ? option.provider : `${option.provider} · ${option.dimensions}`;
  return (
    <span className="flex flex-col">
      <span>{option.name}</span>
      <span className="text-xs leading-4 text-muted-foreground">{details}</span>
      {option.unavailableReason !== null && (
        <StateBadge state="off">
          {t('defaults.offBadge', { reason: unavailableShortText(t, option.unavailableReason) })}
        </StateBadge>
      )}
    </span>
  );
}

/**
 * UXRD MP-08: only working models are offered; a chosen model that does not work stays first, not selectable,
 * with the «Выключено» words (the closed field takes text only, so they follow the title there).
 */
function selectOptions(
  t: ModelsTranslator,
  options: readonly ModelOption[],
  chosen: ModelOption | undefined,
): AdminSelectOption[] {
  const working = options.filter((option) => option.unavailableReason === null);
  const stuck =
    chosen !== undefined && chosen.unavailableReason !== null
      ? [
          {
            value: chosen.value,
            label: t('defaults.offLabel', { label: chosen.label, reason: unavailableShortText(t, chosen.unavailableReason) }),
            content: optionContent(t, chosen),
            disabled: true,
          },
        ]
      : [];
  return [
    ...stuck,
    { value: NONE, label: t('defaults.none') },
    ...working.map((option) => ({ value: option.value, label: option.label, content: optionContent(t, option) })),
  ];
}

function warningOf(
  t: ModelsTranslator,
  purpose: ModelPurpose,
  chosen: ModelOption | undefined,
  value: string | null,
): string | undefined {
  if (value === null) return t(`defaults.${purpose}.notChosen`);
  if (chosen === undefined || chosen.unavailableReason === null) return undefined;
  const notWorking = t('defaults.notWorking', {
    model: chosen.name,
    reason: chosen.unavailableReason,
    provider: chosen.provider,
  });
  return `${notWorking} ${t(`defaults.${purpose}.consequence`)}`;
}

/** The three reads together: the fields' options come from the catalogue and the providers (design-web «Отличия от UXRD»). */
function loadState(t: ModelsTranslator, resources: readonly Resource<unknown>[]): DataTableState {
  const failed = resources.filter((resource) => resource.status === 'error');
  if (failed.length > 0) {
    return { status: 'error', message: t('defaults.loadFailed'), onRetry: () => failed.forEach((resource) => resource.reload()) };
  }
  return { status: 'loading' };
}

type ModelDefaultsFormProps = {
  defaults: Resource<ModelDefaults>;
  providers: Resource<ModelProviderView[]>;
  catalog: Resource<CatalogModel[]>;
  reloadAll: () => void;
};

/** MP-01: the chat and the embedding model by default, the first block of «Модели». */
export function ModelDefaultsForm({ defaults, providers, catalog, reloadAll }: ModelDefaultsFormProps) {
  const t = useTranslations('admin.models');
  const locale = useLocale();
  const headingId = useId();
  const saved = defaults.data;
  const providerList = providers.data;
  const models = catalog.data;
  const ready = saved !== undefined && providerList !== undefined && models !== undefined;

  const optionsOf = (purpose: ModelPurpose): ModelOption[] =>
    ready
      ? modelOptions({ models, purpose, readinessOf: (modelId) => modelUnavailableReason(modelId, providerList), locale })
      : [];
  const options: Record<ModelPurpose, ModelOption[]> = { chat: optionsOf('chat'), embedding: optionsOf('embedding') };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {t('defaultsTitle')}
      </h2>
      {!ready ? (
        <div className="max-w-160">
          <DataTable caption={t('defaultsTitle')} columns={[]} state={loadState(t, [defaults, providers, catalog])} />
        </div>
      ) : (
        // KD-1: remounted only when the saved values change, so a change in another block keeps an unsaved choice.
        <AdminForm<DefaultsValues>
          key={`${saved.chatModel ?? NONE}|${saved.embeddingModel ?? NONE}`}
          variant="page"
          initialValues={{ chat: saved.chatModel, embedding: saved.embeddingModel }}
          validate={() => ({})}
          onSubmit={async (values) => {
            await adminApi.modelDefaults.save({ chatModel: values.chat, embeddingModel: values.embedding });
          }}
          submitLabel={t('defaults.save')}
          savedText={t('defaults.saved')}
          onSaved={reloadAll}
          logEvent="admin: model defaults save"
        >
          {(form) =>
            (['chat', 'embedding'] as const).map((purpose) => {
              const value = form.values[purpose];
              const chosen = options[purpose].find((option) => option.value === value);
              const nothingToChoose = options[purpose].every((option) => option.unavailableReason !== null);
              return (
                <AdminSelectField
                  key={purpose}
                  id={MODEL_DEFAULT_FIELD_ID[purpose]}
                  label={t(`defaults.${purpose}.label`)}
                  value={value}
                  emptyText={t('defaults.none')}
                  options={selectOptions(t, options[purpose], chosen)}
                  onChange={(next) => form.set(purpose, next === NONE ? null : next)}
                  error={form.field(purpose).error}
                  hint={t(nothingToChoose ? `defaults.${purpose}.nothingToChoose` : `defaults.${purpose}.hint`)}
                  warning={warningOf(t, purpose, chosen, value)}
                  // The Base UI trigger is not a native field: the form's disabled fieldset does not reach it.
                  disabled={form.saving || nothingToChoose}
                />
              );
            })
          }
        </AdminForm>
      )}
    </section>
  );
}
