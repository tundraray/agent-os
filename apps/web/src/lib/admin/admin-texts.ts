import {
  KNOWLEDGE_LIMIT_TOKENS_MAX,
  KNOWLEDGE_LIMIT_TOKENS_MIN,
  MODEL_PROVIDER_API_KEY_MAX_LENGTH,
  MODEL_PROVIDER_API_KEY_MIN_LENGTH,
  MODEL_PROVIDER_NAME_MAX_LENGTH,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  TOOL_RESULT_PREVIEW_CHARS_MAX,
  TOOL_RESULT_PREVIEW_CHARS_MIN,
  TOOL_RESULT_READ_MAX_TOKENS_MAX,
  TOOL_RESULT_READ_MAX_TOKENS_MIN,
  TOOL_RESULT_STORE_FROM_CHARS_MAX,
  TOOL_RESULT_STORE_FROM_CHARS_MIN,
  type GrantEffect,
  type McpCheckFailureReason,
  type ProviderCheckFailure,
} from '@agent-os/contracts';

/**
 * Error texts of the admin panel's fields and forms (enterprise-access UXRD, MC-20, MC-22, MC-23, MC-25,
 * MC-26, MC-27, MC-29, MC-30, MC-33; model-providers UXRD, MC-1 – MC-7). The only place
 * these texts live: field rules and `describeAdminError`
 * take them from here.
 */

/** MC-20: a save the server refused, named by `reason`. */
export const saveFailed = (reason: string): string => `Не удалось сохранить: ${reason}`;

export const ADMIN_TEXT = {
  // MC-22, MC-23
  loginRequired: 'Введите логин',
  nameRequired: 'Введите имя',
  emailRequired: 'Введите почту',
  passwordLength: 'Пароль — от 12 до 256 знаков',
  loginTaken: 'Такой логин уже есть',
  emailTaken: 'Сотрудник с такой почтой уже есть',
  // MC-25
  serverRequired: 'Выберите сервер',
  toolRequired: 'Выберите инструмент',
  modelRequired: 'Выберите модель',
  quotaRange: 'Квота — от 0,01 до 1 000 000 $, не больше двух знаков после запятой',
  grantTargetUnknown: 'Этого сервера, инструмента или модели больше нет. Закройте окно и выберите цель снова.',
  grantInvalid: 'Так нельзя: запрет даётся только лично, а квота — только у разрешения модели.',
  // MC-26
  roleNameRequired: 'Введите название',
  roleNameTaken: 'Такая роль уже есть',
  // MC-27
  providerNameLength: 'Название — от 1 до 60 знаков',
  providerIncomplete: 'Нельзя включить: сначала заполните настройки провайдера.',
  // MC-29
  serverNameRule: 'Имя — от 1 до 32 знаков: строчные латинские буквы, цифры и дефис, например sentry-prod',
  serverNameTaken: 'Сервер с таким именем уже есть',
  serverUrl: 'Введите адрес, который начинается с https://',
  sharedToken: 'Введите токен — до 4096 знаков',
  serverIncomplete: 'Нельзя включить: сначала подключите свой аккаунт и получите список инструментов.',
  connectFailed: 'Не удалось подключить ваш аккаунт: вход отменён или не завершён. Попробуйте ещё раз.',
  toolsFailed: 'Аккаунт подключён, но список инструментов получить не удалось. Нажмите «Обновить список».',
  // MC-30
  // At the field «Имя модели у провайдера» (model-providers MC-7).
  modelIdTaken: 'Модель с таким ID уже есть в каталоге',
  modelNameLength: 'Название — от 1 до 80 знаков',
  thresholdRule: 'Порог — целое число больше нуля',
  priceRule: 'Введите цену — число от 0',
  // MC-33
  fullUrl: 'Введите полный адрес, например https://agent-os.example',
  idleHours: 'Введите от 0,25 до 24 часов с шагом 0,25',
  absoluteHours: 'Введите целое число от 1 до 720',
  absoluteBelowIdle: 'Общий срок не может быть меньше срока без активности',
  // Not in the UXRD: the library's setting «Лимит ходов для новой записи».
  defaultMaxTurns: `Введите целое число от ${RECORD_MAX_TURNS_MIN} до ${RECORD_MAX_TURNS_MAX}`,
  // self-learning MC-8: «Место для знаний в запуске, токенов».
  knowledgeLimitTokens: `Нужно целое число от ${KNOWLEDGE_LIMIT_TOKENS_MIN} до ${KNOWLEDGE_LIMIT_TOKENS_MAX}`,
  // tool-result-reading R-5: «Большие результаты инструментов» under «MCP-серверы».
  toolResultStoreFromChars: `Нужно целое число от ${TOOL_RESULT_STORE_FROM_CHARS_MIN} до ${TOOL_RESULT_STORE_FROM_CHARS_MAX}`,
  toolResultPreviewChars: `Нужно целое число от ${TOOL_RESULT_PREVIEW_CHARS_MIN} до ${TOOL_RESULT_PREVIEW_CHARS_MAX}`,
  toolResultReadMaxTokens: `Нужно целое число от ${TOOL_RESULT_READ_MAX_TOKENS_MIN} до ${TOOL_RESULT_READ_MAX_TOKENS_MAX}`,
  toolResultPreviewBelowThreshold: 'Начало должно быть меньше длины, с которой ответ заменяется ссылкой',
  // MC-27
  publicUrlRequired: 'Сначала сохраните публичный адрес Agent OS в настройках входа.',
  // MC-20
  listChanged: 'Список изменился. Откройте раздел заново.',
  noConnection: saveFailed('нет связи с сервером'),
  // model-providers MC-4; an empty name is `nameRequired`
  modelProviderNameRule: `Имя — до ${MODEL_PROVIDER_NAME_MAX_LENGTH} знаков: строчные латинские буквы, цифры и дефис, не с дефиса, например local-2`,
  modelProviderUrl: 'Введите полный адрес, например https://api.example.com/v1',
  modelProviderApiKey: `Ключ — от ${MODEL_PROVIDER_API_KEY_MIN_LENGTH} до ${MODEL_PROVIDER_API_KEY_MAX_LENGTH} символов`,
  modelProviderNameTaken: 'Провайдер с таким именем уже есть',
  // model-providers MC-5
  modelProviderHasModels: 'Не удалось удалить: у провайдера есть модели в каталоге. Сначала уберите их.',
  // model-providers MC-7
  modelProviderRequired: 'Выберите провайдера',
  modelNameAtProviderRequired: 'Введите имя модели',
  dimensionsRule: 'Размерность — целое число больше нуля',
  embeddingsNotSupported: saveFailed('провайдер этого типа не считает эмбеддинги'),
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
  // MC-5; the late refusal is `ADMIN_TEXT.modelProviderHasModels`
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

/** model-providers MC-4: the provider dialog; the type words are `PROVIDER_KIND_TEXT`, the field errors `ADMIN_TEXT`. */
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
 * headers, purpose words and price unit from here too; the field errors are `ADMIN_TEXT`.
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

/** model-providers MC-4: the provider being saved is gone. */
export const modelProviderGone = (name: string): string =>
  saveFailed(`провайдера ${name} уже нет. Закройте окно — список обновится.`);

/** model-providers MC-7: the provider of the model being added is gone. */
export const modelProviderUnknown = (name: string): string =>
  saveFailed(`провайдера ${name} больше нет. Закройте окно и откройте его снова.`);

/** model-providers MC-2: a default model of the other purpose, by its label. */
export const modelDefaultWrongPurpose = (model: string): string => saveFailed(`модель ${model} другого назначения`);

/** model-providers MC-2: a default model no longer in the catalogue, by its label. */
export const modelDefaultUnknown = (model: string): string => saveFailed(`модели ${model} больше нет в каталоге`);

/** MC-25: a grant that the holder already has with the same effect. */
export const GRANT_EXISTS_TEXT: Readonly<Record<GrantEffect, string>> = {
  allow: 'Такое право уже есть',
  deny: 'Такой запрет уже есть',
};

const PROVIDER_CHECK_REASON: Readonly<Record<ProviderCheckFailure, string>> = {
  insecure_url: 'адрес не https',
  unreachable: 'адрес не ответил или ответил ошибкой',
  invalid_document: 'по этому адресу нет описания OIDC для этого Issuer',
};

/** MC-27: the provider settings check failed for `reason`. */
export const providerCheckFailed = (reason: ProviderCheckFailure): string =>
  `Не удалось проверить настройки провайдера: ${PROVIDER_CHECK_REASON[reason]}. Настройки не сохранены.`;

/** MC-29: the reason of a failed server check; the registration form prefixes it with `registerFailed`. */
export const MCP_CHECK_REASON: Readonly<Record<McpCheckFailureReason, string>> = {
  unreachable: 'сервер не отвечает по этому адресу',
  timeout: 'сервер не ответил вовремя, попробуйте ещё раз',
  not_mcp: 'по этому адресу не MCP-сервер',
  unauthorized: 'сервер не принял токен доступа',
  oauth_not_supported: 'сервер не поддерживает личный OAuth. Выберите общую учётную запись',
  registration_rejected: 'сервер авторизации отказал Agent OS в регистрации клиента',
  insecure_url: 'адрес сервера или его сервера авторизации не https',
};

/** MC-29: the registration form's error around a check reason. */
export const registerFailed = (reason: string): string => `Не удалось зарегистрировать: ${reason}`;
