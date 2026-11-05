import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import {
  assertNoPendingMigrations,
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from './pending-migrations.js';

/** Constant key of the advisory lock that serialises concurrent migrators across processes. */
const MIGRATION_LOCK_KEY = 4_200_310_031;

/**
 * The only way migrations are applied (ADR-0003): a dedicated connection holding a session
 * advisory lock runs the drizzle migrator (all pending files in one transaction, journal in
 * schema `app`), then verifies that no file is left pending — the migrator silently skips a file
 * timestamped before the last applied one. Closing the connection releases the lock.
 */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migrate(drizzle({ client }), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    await assertNoPendingMigrations(client);
  } finally {
    await client.end();
  }
}
