import * as Sentry from '@sentry/nextjs';

import { SENTRY_DSN_COOKIE } from '@/sentry-dsn-cookie';

// The DSN comes from the cookie that `proxy.ts` sets from the server's `SENTRY_DSN`:
// it is read synchronously so hydration errors and the first log records reach Sentry.
// An empty DSN keeps the SDK silent and logs go to the console only.
// Sentry Logs are always on in `@sentry/nextjs` 11, which has no `enableLogs` option.
function dsnFromCookie(): string | undefined {
  const prefix = `${SENTRY_DSN_COOKIE}=`;
  const entry = document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix));
  const value = entry ? decodeURIComponent(entry.slice(prefix.length)) : '';
  return value || undefined;
}

Sentry.init({ dsn: dsnFromCookie() });
