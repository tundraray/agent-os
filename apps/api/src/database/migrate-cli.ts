import { applyMigrations } from './migrate.js';

/**
 * Entry of `pnpm db:migrate` (run from `dist`, `apps/api/.env` loaded by `--env-file-if-exists`).
 * Exits with a non-zero code and the error — including the names of pending files — on failure.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  await applyMigrations(databaseUrl);
  console.log('Migrations are up to date');
}

try {
  await main();
} catch (error) {
  // The whole error: a connection failure is an AggregateError with an empty message.
  console.error(error);
  process.exitCode = 1;
}
