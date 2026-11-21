/**
 * Texts of the admin panel's sections not yet in the catalogue (enterprise-access UXRD, MC-27, MC-29). Field
 * rules and `describeAdminError` take theirs from the `errors` catalogue.
 */

export const ADMIN_TEXT = {
  // MC-29
  connectFailed: 'Не удалось подключить ваш аккаунт: вход отменён или не завершён. Попробуйте ещё раз.',
  toolsFailed: 'Аккаунт подключён, но список инструментов получить не удалось. Нажмите «Обновить список».',
  // MC-27
  publicUrlRequired: 'Сначала сохраните публичный адрес Agent OS в настройках входа.',
} as const;
