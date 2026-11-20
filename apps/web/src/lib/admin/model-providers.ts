import {
  modelProvider,
  type ModelProviderKind,
  type ModelProviderState,
  type ModelProviderView,
  type ModelPurpose,
  type ModelUnavailableReason,
} from '@agent-os/contracts';

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
export const MODEL_UNAVAILABLE_SHORT_TEXT: Readonly<Record<ModelUnavailableReason, string>> = {
  provider_disabled: 'провайдер выключен',
  provider_missing: 'нет провайдера',
  provider_key_missing: 'нет ключа',
};

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
  /** For a screen reader: «{название}, провайдер {провайдер}». */
  accessibleName: string;
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
    accessibleName: `${model.name}, провайдер ${provider}`,
    unavailableReason,
  };
}

/**
 * The options of a model choice (MP-01, the grant dialog, the record editors): only models of `purpose`,
 * each with its readiness, by provider name and then by title. The caller decides what to offer.
 */
export function modelOptions(
  models: readonly ModelOptionSource[],
  purpose: ModelPurpose,
  readinessOf: (modelId: string) => ModelUnavailableReason | null,
): ModelOption[] {
  return models
    .filter((model) => model.purpose === purpose)
    .map((model) => optionOf(model, readinessOf(model.id)))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
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

const KEY_NEEDED_HINT = 'Без ключа модели этого провайдера не работают.';

/** UXRD KD-1, MC-3, MC-4: the words of each provider type. */
export const PROVIDER_KIND_TEXT: Readonly<Record<ModelProviderKind, ProviderKindText>> = {
  anthropic: {
    label: 'Anthropic',
    hint: null,
    baseUrlHint: 'Пусто — официальный адрес Anthropic.',
    apiKeyHint: KEY_NEEDED_HINT,
  },
  gemini: {
    label: 'Google Gemini',
    hint: 'По ключу Gemini API.',
    baseUrlHint: 'Пусто — официальный адрес Gemini API.',
    apiKeyHint: KEY_NEEDED_HINT,
  },
  openai_compatible: {
    label: 'OpenAI-совместимый',
    hint: 'OpenAI, vLLM, корпоративный шлюз — любой сервер с API в формате OpenAI.',
    baseUrlHint: 'Адрес API сервера, например http://vllm.corp:8000/v1. Пусто — адрес OpenAI.',
    apiKeyHint: 'Оставьте пустым, если серверу ключ не нужен.',
  },
};

/** MP-04: the name the type puts into «Имя» of a new provider; an OpenAI-compatible one has none. */
export const DEFAULT_PROVIDER_NAME: Readonly<Record<ModelProviderKind, string | null>> = {
  anthropic: 'anthropic',
  gemini: 'google',
  openai_compatible: null,
};
