import * as Sentry from '@sentry/nextjs';

// An empty DSN keeps the SDK silent and logs go to the console only (design-runtime.md, Runtime settings).
// Sentry Logs are always on in `@sentry/nextjs` 11, which has no `enableLogs` option.
export function register(): void {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || undefined });
  }
}

export const onRequestError = Sentry.captureRequestError;
