import * as Sentry from '@sentry/nextjs';

// `SENTRY_DSN` has no `NEXT_PUBLIC_` prefix, so it is read when the server starts, not baked in at build.
// An empty DSN keeps the SDK silent and logs go to the console only.
// Sentry Logs are always on in `@sentry/nextjs` 11, which has no `enableLogs` option.
export function register(): void {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({ dsn: process.env.SENTRY_DSN || undefined });
  }
}

export const onRequestError = Sentry.captureRequestError;
