import { existsSync } from 'node:fs';
import * as Sentry from '@sentry/nestjs';
import { withoutQueryParamsText } from '@agent-os/common';

// Imported first by `main.ts`: Sentry must be initialised before the rest of the application loads.
if (existsSync('.env')) process.loadEnvFile('.env');

// An empty DSN keeps the SDK silent and logs go to the console only (design-runtime.md, Runtime settings).
// Sentry Logs are on by default since SDK 10.71 (no `enableLogs`), so `Sentry.logger` records reach Sentry once a DSN is set.
Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  // An error the SDK captures by itself (unhandled, uncaught) does not pass the logger: a failed
  // query's bound values are cut from its message here, as the logger cuts them.
  beforeSend(event) {
    for (const exception of event.exception?.values ?? []) {
      if (exception.value !== undefined)
        exception.value = withoutQueryParamsText(exception.value);
    }
    return event;
  },
});
