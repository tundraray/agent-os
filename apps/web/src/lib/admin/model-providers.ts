import {
  modelProvider,
  type ModelProviderKind,
  type ModelProviderState,
  type ModelProviderView,
  type ModelPurpose,
  type ModelUnavailableReason,
} from '@agent-os/contracts';
import type { ModelsTranslator } from '@/lib/i18n/messages';
import type { Locale } from '@/lib/i18n/pick-locale';

/**
 * Model providers in the panel (model-providers design-web.md, KD-5): readiness of a model by the list of
 * providers, the options of a model choice, and the words of provider types and short reasons.
 */

/** A provider's `state` from `core` decides readiness: the web never repeats which kind needs a key. */
const REASON_OF_STATE: Readonly<Record<ModelProviderState, ModelUnavailableReason | null>> = {
  ready: null,
  disabled: 'provider_disabled',
  key_missing: 'provider_key_missing',
};

/** Why a model does not work now: its provider is missing, off or without a needed key; `null` — it works. */
export function modelUnavailableReason(
  modelId: string,
  providers: readonly Pick<ModelProviderView, 'name' | 'state'>[],
): ModelUnavailableReason | null {
  const name = modelProvider(modelId);
  const provider = providers.find((candidate) => candidate.name === name);
  return provider === undefined ? 'provider_missing' : REASON_OF_STATE[provider.state];
}

/** UXRD MC-8: the short reason on the «Выключено» badge of a model that does not work. */
export const unavailableShortText = (t: ModelsTranslator, reason: ModelUnavailableReason): string =>
  t(`unavailable.${reason}`);

/** For a screen reader: «{название}, провайдер {провайдер}», and the short reason of a model that does not work. */
export function modelOptionName(
  t: ModelsTranslator,
  { name, provider, unavailableReason }: Pick<ModelOption, 'name' | 'provider' | 'unavailableReason'>,
): string {
  if (unavailableReason === null) return t('optionName', { name, provider });
  return t('optionNameOff', { name, provider, reason: unavailableShortText(t, unavailableReason) });
}

/** A model a choice can offer: a catalogue row, or an employee's model mapped to these fields. */
export type ModelOptionSource = {
  id: string;
  name: string;
  purpose: ModelPurpose;
  /** Only an embedding model has it. */
  dimensions?: number;
};

export type ModelOption = {
  value: string;
  name: string;
  provider: string;
  /** `null` for a chat model. */
  dimensions: number | null;
  /** The closed field (MC-8): «{название} · {провайдер}», an embedding adds «· {размерность}». */
  label: string;
  unavailableReason: ModelUnavailableReason | null;
};

const SEPARATOR = ' · ';

function optionOf(model: ModelOptionSource, unavailableReason: ModelUnavailableReason | null): ModelOption {
  const provider = modelProvider(model.id);
  const dimensions = model.dimensions ?? null;
  const parts = dimensions === null ? [model.name, provider] : [model.name, provider, String(dimensions)];
  return {
    value: model.id,
    name: model.name,
    provider,
    dimensions,
    label: parts.join(SEPARATOR),
    unavailableReason,
  };
}

/**
 * The options of a model choice (MP-01, the grant dialog, the record editors): only models of `purpose`,
 * each with its readiness, by provider name and then by title in the page's language. The caller decides
 * what to offer.
 */
export function modelOptions({
  models,
  purpose,
  readinessOf,
  locale,
}: {
  models: readonly ModelOptionSource[];
  purpose: ModelPurpose;
  readinessOf: (modelId: string) => ModelUnavailableReason | null;
  locale: Locale;
}): ModelOption[] {
  return models
    .filter((model) => model.purpose === purpose)
    .map((model) => optionOf(model, readinessOf(model.id)))
    .sort((a, b) => a.provider.localeCompare(b.provider, locale) || a.name.localeCompare(b.name, locale));
}

export type ProviderKindText = {
  /** MC-3, MC-4: the type's name. */
  label: string;
  /** MC-4: the hint under the type's radio button; Anthropic has none. */
  hint: string | null;
  /** MC-4: the hint of «Адрес». */
  baseUrlHint: string;
  /** MC-4: the hint of «Ключ». */
  apiKeyHint: string;
};

/** UXRD KD-1, MC-3, MC-4: the words of a provider type. */
export function providerKindText(t: ModelsTranslator, kind: ModelProviderKind): ProviderKindText {
  return {
    label: t(`kind.${kind}.label`),
    hint: kind === 'anthropic' ? null : t(`kind.${kind}.hint`),
    baseUrlHint: t(`kind.${kind}.baseUrlHint`),
    apiKeyHint: kind === 'openai_compatible' ? t('kind.openai_compatible.apiKeyHint') : t('kind.keyNeededHint'),
  };
}

/** MP-04: the name the type puts into «Имя» of a new provider; an OpenAI-compatible one has none. */
export const DEFAULT_PROVIDER_NAME: Readonly<Record<ModelProviderKind, string | null>> = {
  anthropic: 'anthropic',
  gemini: 'google',
  openai_compatible: null,
};
