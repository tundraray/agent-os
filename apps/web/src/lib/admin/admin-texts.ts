/**
 * Texts of the admin panel's sections not yet in the catalogue (enterprise-access UXRD, MC-27, MC-29; model-providers
 * UXRD, MC-1 – MC-7). Field rules and `describeAdminError` take theirs from the `errors` catalogue.
 */

export const ADMIN_TEXT = {
  // MC-29
  connectFailed: 'Не удалось подключить ваш аккаунт: вход отменён или не завершён. Попробуйте ещё раз.',
  toolsFailed: 'Аккаунт подключён, но список инструментов получить не удалось. Нажмите «Обновить список».',
  // MC-27
  publicUrlRequired: 'Сначала сохраните публичный адрес Agent OS в настройках входа.',
  // model-providers MC-7
  modelProviderRequired: 'Выберите провайдера',
} as const;

/** model-providers MC-1: the «Модели» section's blocks and their buttons. */
export const MODELS_TEXT = {
  defaultsTitle: 'Модели по умолчанию',
  providersTitle: 'Провайдеры',
  catalogTitle: 'Каталог моделей',
  addProvider: 'Добавить провайдера',
  addModel: 'Добавить модель',
  addModelNeedsProvider: 'Сначала добавьте провайдера',
} as const;

/** model-providers MC-3, MC-5, MC-6: the providers' table, its removal and its connection check. */
export const MODEL_PROVIDERS_TEXT = {
  // MC-3
  provider: 'Провайдер',
  kind: 'Тип',
  key: 'Ключ',
  models: 'Моделей',
  enabled: 'Включён',
  defaultUrl: 'адрес по умолчанию',
  keyEnding: (last4: string) => `…${last4}`,
  keyEndingName: (last4: string) => `ключ заканчивается на ${last4}`,
  keyNeeded: 'Нужен ключ',
  keyNeededName: 'ключ не задан, модели не работают',
  noKey: 'без ключа',
  enabledSwitch: (name: string) => `Включён: ${name}`,
  edit: 'Изменить',
  check: 'Проверить подключение',
  remove: 'Удалить',
  empty: 'Провайдеров пока нет',
  emptyDescription:
    'Добавьте провайдера, чтобы подключить его модели: Anthropic, Google Gemini или сервер, совместимый с OpenAI.',
  loadFailed: 'Не удалось загрузить провайдеров',
  offTitle: (name: string) => `Выключить провайдера «${name}»?`,
  offChat: (model: string) => `${model} — модель чата по умолчанию: пока провайдер выключен, чат не отвечает сотрудникам.`,
  offEmbedding: (model: string) =>
    `${model} — модель эмбеддингов по умолчанию: пока провайдер выключен, отбор по смыслу в самообучении выключен.`,
  off: 'Выключить',
  // MC-5; the late refusal is `describeAdminError`'s
  cannotRemoveTitle: (name: string) => `Нельзя удалить «${name}»`,
  cannotRemoveBody: (count: number) => `Моделей этого провайдера в каталоге: ${count}. Сначала уберите их из каталога.`,
  understood: 'Понятно',
  removeTitle: (name: string) => `Удалить провайдера «${name}»?`,
  removeBody: 'Ключ провайдера удалится вместе с ним. Вернуть нельзя.',
  removed: 'Провайдер удалён',
  // MC-6
  checking: 'Проверяем подключение…',
  works: 'Работает',
  checkedAt: (time: string) => `· ${time}`,
  keyRejected: (message: string | null) => (message === null ? 'Ключ отклонён' : `Ключ отклонён: ${message}`),
  unreachable: (message: string | null) => (message === null ? 'Адрес недоступен' : `Адрес недоступен: ${message}`),
  checkNoConnection: 'Не удалось проверить: нет связи с сервером',
  checkFailed: (message: string) => `Не удалось проверить: ${message}`,
  checkingName: (name: string) => `Проверяем подключение ${name}…`,
  worksName: (name: string) => `${name}: работает`,
  keyRejectedName: (name: string) => `${name}: ключ отклонён`,
  unreachableName: (name: string) => `${name}: адрес недоступен`,
  checkFailedName: (name: string) => `${name}: не удалось проверить`,
} as const;

/** model-providers MC-4: the provider dialog; the type words are `PROVIDER_KIND_TEXT`, the field errors `form-rules.ts`. */
export const MODEL_PROVIDER_DIALOG_TEXT = {
  addTitle: 'Новый провайдер',
  editTitle: (name: string) => `Провайдер ${name}`,
  kind: 'Тип',
  name: 'Имя',
  nameHint: (name: string) => `Первая часть ID его моделей: ${name}/<модель>. После добавления имя не меняется.`,
  // The hint's example while «Имя» is still empty.
  namePlaceholder: 'имя',
  baseUrl: 'Адрес (необязательно)',
  apiKeyOptional: 'Ключ (необязательно)',
  apiKey: 'Ключ',
  fixed: (name: string, kind: string) => `${name} · ${kind}`,
  fixedHint: 'Имя и тип не меняются. Нужны другие — добавьте нового провайдера.',
  add: 'Добавить',
  save: 'Сохранить',
  added: (name: string) => `Провайдер ${name} добавлен`,
  saved: (name: string) => `Провайдер ${name} сохранён`,
} as const;

/**
 * enterprise-access MC-30 and model-providers MC-7: the model dialog (MP-06). The catalogue takes its column
 * headers, purpose words and price unit from here too; the field errors are `form-rules.ts`'s.
 */
export const MODEL_DIALOG_TEXT = {
  add: 'Добавить модель',
  edit: 'Изменить',
  provider: 'Провайдер',
  providerOption: (name: string, kind: string) => `${name} · ${kind}`,
  purpose: 'Назначение',
  chat: 'Чат',
  embedding: 'Эмбеддинги',
  noAnthropicEmbeddings: 'У Anthropic нет моделей эмбеддингов.',
  modelName: 'Имя модели у провайдера',
  modelNameHint: 'Как модель называется в API провайдера, например gemini-2.5-flash.',
  idPreview: (provider: string, modelName: string) => `ID: ${provider}/${modelName}`,
  // The preview's parts while the provider or the name is not chosen yet.
  providerPlaceholder: 'провайдер',
  modelNamePlaceholder: 'имя',
  name: 'Название',
  dimensions: 'Размерность',
  dimensionsHint: 'Сколько чисел в векторе, например 768. После добавления не меняется.',
  fixed: (id: string, purpose: string) => `${id} · ${purpose}`,
  fixedDimensions: (dimensions: number) => ` · ${dimensions}`,
  priceUnit: '$ за 1 млн токенов',
  // Not in MC-30: the second group of prices needs a name of its own for a screen reader.
  longPriceUnit: '$ за 1 млн токенов для длинных запросов',
  longContext: 'Другие цены для длинных запросов',
  threshold: 'Порог, входных токенов',
  save: 'Сохранить',
  // Not in MC-30: the notices of a save, after «Роль удалена».
  added: 'Модель добавлена',
  saved: 'Модель сохранена',
  chooseDefault: 'Выбрать по умолчанию',
} as const;
