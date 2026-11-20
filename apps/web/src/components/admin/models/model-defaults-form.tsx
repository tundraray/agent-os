'use client';

import { useId } from 'react';
import type { CatalogModel, ModelDefaults, ModelProviderView, ModelPurpose, ModelUnavailableReason } from '@agent-os/contracts';
import { StateBadge } from '@/components/state-badge';
import type { Resource } from '@/hooks/use-resource';
import { adminApi } from '@/lib/admin/admin-api';
import { MODELS_TEXT } from '@/lib/admin/admin-texts';
import {
  MODEL_UNAVAILABLE_SHORT_TEXT,
  modelOptions,
  modelUnavailableReason,
  type ModelOption,
} from '@/lib/admin/model-providers';
import { AdminForm, AdminSelectField, type AdminSelectOption } from '../admin-form';
import { DataTable, type DataTableState } from '../data-table';

/** UXRD MC-2; «Выключено» — the state-badge word (MC-8). */
const TEXT = {
  chatLabel: 'Модель чата',
  chatHint:
    'На ней работают чат и системные агенты, её же получает каждый новый агент. Агенты, у которых своя модель, на ней и остаются.',
  embeddingLabel: 'Модель эмбеддингов',
  embeddingHint:
    'На ней самообучение отбирает знания, близкие по смыслу к вопросу. После смены знания какое-то время заново готовятся к отбору.',
  none: 'Не выбрана',
  chatNotChosen: 'Пока модель чата не выбрана, чат не отвечает сотрудникам.',
  embeddingNotChosen: 'Пока модель эмбеддингов не выбрана, отбор по смыслу в самообучении выключен.',
  notWorking: (model: string, reason: string): string => `Модель ${model} сейчас не работает: ${reason}.`,
  chatConsequence:'Пока это так, чат не отвечает.',
  embeddingConsequence: 'Пока это так, отбор по смыслу в самообучении выключен.',
  chatNothingToChoose: 'В каталоге нет работающих моделей чата — добавьте модель ниже.',
  embeddingNothingToChoose:
    'В каталоге нет работающих моделей эмбеддингов — добавьте модель с назначением «Эмбеддинги» ниже.',
  off: 'Выключено',
  save: 'Сохранить',
  saved: 'Модели по умолчанию сохранены',
  loadFailed: 'Не удалось загрузить модели по умолчанию',
} as const;

const REASON_TEXT: Readonly<Record<ModelUnavailableReason, (provider: string) => string>> = {
  provider_disabled: (provider) => `провайдер ${provider} выключен`,
  provider_missing: (provider) => `провайдера ${provider} нет`,
  provider_key_missing: (provider) => `у провайдера ${provider} нет ключа`,
};

/** Constant ids, so «Выбрать по умолчанию» of the model dialog can move focus into the field of its purpose. */
export const MODEL_DEFAULT_FIELD_ID = {
  chat: 'model-default-chat',
  embedding: 'model-default-embedding',
} as const satisfies Record<ModelPurpose, string>;

type DefaultsValues = { chat: string | null; embedding: string | null };

/** The «Не выбрана» option; a model id always holds «/», so it never collides with one. */
const NONE = 'none';

const PURPOSE_TEXT = {
  chat: {
    label: TEXT.chatLabel,
    hint: TEXT.chatHint,
    notChosen: TEXT.chatNotChosen,
    consequence: TEXT.chatConsequence,
    nothingToChoose: TEXT.chatNothingToChoose,
  },
  embedding: {
    label: TEXT.embeddingLabel,
    hint: TEXT.embeddingHint,
    notChosen: TEXT.embeddingNotChosen,
    consequence: TEXT.embeddingConsequence,
    nothingToChoose: TEXT.embeddingNothingToChoose,
  },
} as const satisfies Record<ModelPurpose, Record<string, string>>;

/** The open list: the title, then the provider (and the dimension), and the badge of a model that does not work. */
function optionContent(option: ModelOption) {
  const details = option.dimensions === null ? option.provider : `${option.provider} · ${option.dimensions}`;
  return (
    <span className="flex flex-col">
      <span>{option.name}</span>
      <span className="text-xs leading-4 text-muted-foreground">{details}</span>
      {option.unavailableReason !== null && (
        <StateBadge state="off">{`${TEXT.off} · ${MODEL_UNAVAILABLE_SHORT_TEXT[option.unavailableReason]}`}</StateBadge>
      )}
    </span>
  );
}

/**
 * UXRD MP-08: only working models are offered; a chosen model that does not work stays first, not selectable,
 * with the «Выключено» words (the closed field takes text only, so they follow the title there).
 */
function selectOptions(options: readonly ModelOption[], chosen: ModelOption | undefined): AdminSelectOption[] {
  const working = options.filter((option) => option.unavailableReason === null);
  const stuck =
    chosen !== undefined && chosen.unavailableReason !== null
      ? [
          {
            value: chosen.value,
            label: `${chosen.label} — ${TEXT.off}: ${MODEL_UNAVAILABLE_SHORT_TEXT[chosen.unavailableReason]}`,
            content: optionContent(chosen),
            disabled: true,
          },
        ]
      : [];
  return [
    ...stuck,
    { value: NONE, label: TEXT.none },
    ...working.map((option) => ({ value: option.value, label: option.label, content: optionContent(option) })),
  ];
}

function warningOf(purpose: ModelPurpose, chosen: ModelOption | undefined, value: string | null): string | undefined {
  const text = PURPOSE_TEXT[purpose];
  if (value === null) return text.notChosen;
  if (chosen === undefined || chosen.unavailableReason === null) return undefined;
  const reason = REASON_TEXT[chosen.unavailableReason](chosen.provider);
  return `${TEXT.notWorking(chosen.name, reason)} ${text.consequence}`;
}

/** The three reads together: the fields' options come from the catalogue and the providers (design-web «Отличия от UXRD»). */
function loadState(resources: readonly Resource<unknown>[]): DataTableState {
  const failed = resources.filter((resource) => resource.status === 'error');
  if (failed.length > 0) {
    return { status: 'error', message: TEXT.loadFailed, onRetry: () => failed.forEach((resource) => resource.reload()) };
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
  const headingId = useId();
  const saved = defaults.data;
  const providerList = providers.data;
  const models = catalog.data;
  const ready = saved !== undefined && providerList !== undefined && models !== undefined;

  const optionsOf = (purpose: ModelPurpose): ModelOption[] =>
    ready ? modelOptions(models, purpose, (modelId) => modelUnavailableReason(modelId, providerList)) : [];
  const options: Record<ModelPurpose, ModelOption[]> = { chat: optionsOf('chat'), embedding: optionsOf('embedding') };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base leading-6 font-semibold">
        {MODELS_TEXT.defaultsTitle}
      </h2>
      {!ready ? (
        <div className="max-w-160">
          <DataTable caption={MODELS_TEXT.defaultsTitle} columns={[]} state={loadState([defaults, providers, catalog])} />
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
          submitLabel={TEXT.save}
          savedText={TEXT.saved}
          onSaved={reloadAll}
          logEvent="admin: model defaults save"
        >
          {(form) =>
            (['chat', 'embedding'] as const).map((purpose) => {
              const value = form.values[purpose];
              const chosen = options[purpose].find((option) => option.value === value);
              const nothingToChoose = options[purpose].every((option) => option.unavailableReason !== null);
              const text = PURPOSE_TEXT[purpose];
              return (
                <AdminSelectField
                  key={purpose}
                  id={MODEL_DEFAULT_FIELD_ID[purpose]}
                  label={text.label}
                  value={value}
                  emptyText={TEXT.none}
                  options={selectOptions(options[purpose], chosen)}
                  onChange={(next) => form.set(purpose, next === NONE ? null : next)}
                  error={form.field(purpose).error}
                  hint={nothingToChoose ? text.nothingToChoose : text.hint}
                  warning={warningOf(purpose, chosen, value)}
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
