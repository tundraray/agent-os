import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { applyMigrations } from '../../src/database/migrate.js';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

/** `DATABASE_URL` as the app sees it: the process environment first, otherwise `apps/api/.env`. */
function databaseUrl(): string {
  const url =
    process.env.DATABASE_URL ??
    parseEnv(readFileSync(ENV_FILE, 'utf8')).DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/**
 * Vitest global setup of the e2e suite: applies migrations once, before any test file boots the
 * app (whose start fails on pending migrations), through the same function as `pnpm db:migrate`.
 */
export default async function setup(): Promise<void> {
  await applyMigrations(databaseUrl());
}
