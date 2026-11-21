import * as Sentry from '@sentry/nextjs';

// The DSN comes from the `aos_sentry_dsn` cookie that `proxy.ts` sets from the server's `SENTRY_DSN`:
// it is read synchronously so hydration errors and the first log records reach Sentry.
// An empty DSN keeps the SDK silent and logs go to the console only.
// Sentry Logs are always on in `@sentry/nextjs` 11, which has no `enableLogs` option.
function dsnFromCookie(): string | undefined {
  const entry = document.cookie.split('; ').find((cookie) => cookie.startsWith('aos_sentry_dsn='));
  const value = entry ? decodeURIComponent(entry.slice('aos_sentry_dsn='.length)) : '';
  return value || undefined;
}

Sentry.init({ dsn: dsnFromCookie() });
