/** The user `SessionGuard` resolves in development; shown in the sidebar until real auth exists. */
export const DEV_USER = {
  id: 'dev-user',
  name: 'dev-user',
  initials: 'DU',
  caption: 'Режим разработки',
} as const;
