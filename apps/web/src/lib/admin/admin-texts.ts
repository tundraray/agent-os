import type { GrantEffect, McpCheckFailureReason, ProviderCheckFailure } from '@agent-os/contracts';

/**
 * Error texts of the admin panel's fields and forms (enterprise-access UXRD, MC-20, MC-22, MC-23, MC-25,
 * MC-26, MC-27, MC-29, MC-30, MC-33). The only place these texts live: field rules and `describeAdminError`
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
  modelIdFormat: 'ID — в виде anthropic/<имя>',
  modelIdTaken: 'Модель с таким ID уже есть в каталоге',
  modelNameLength: 'Название — от 1 до 80 знаков',
  thresholdRule: 'Порог — целое число больше нуля',
  priceRule: 'Введите цену — число от 0',
  // MC-33
  fullUrl: 'Введите полный адрес, например https://agent-os.example',
  idleHours: 'Введите от 0,25 до 24 часов с шагом 0,25',
  absoluteHours: 'Введите целое число от 1 до 720',
  absoluteBelowIdle: 'Общий срок не может быть меньше срока без активности',
  // MC-27
  publicUrlRequired: 'Сначала сохраните публичный адрес Agent OS в настройках входа.',
  // MC-20
  listChanged: 'Список изменился. Откройте раздел заново.',
  noConnection: saveFailed('нет связи с сервером'),
} as const;

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
