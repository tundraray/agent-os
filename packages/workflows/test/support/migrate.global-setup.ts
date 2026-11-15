import { applyMigrations } from '@agent-os/db';
import { databaseUrl } from './database-url.js';

/**
 * Vitest global setup of the package's Postgres suites: applies migrations once, before any test
 * file builds a runtime, through the same function as `pnpm db:migrate`.
 */
export default async function setup(): Promise<void> {
  await applyMigrations(databaseUrl());
}
