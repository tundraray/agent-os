import { existsSync } from 'node:fs';
import * as Sentry from '@sentry/nestjs';

// Imported first by `main.ts`: Sentry must be initialised before the rest of the application loads.
if (existsSync('.env')) process.loadEnvFile('.env');

// An empty DSN keeps the SDK silent and logs go to the console only (design-runtime.md, Runtime settings).
// Sentry Logs are on by default since SDK 10.71 (no `enableLogs`), so `Sentry.logger` records reach Sentry once a DSN is set.
Sentry.init({ dsn: process.env.SENTRY_DSN || undefined });
