import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type pg from 'pg';
import { z } from 'zod';

/** Schema of the migration journal (ADR-0003); every migrator call and check passes it explicitly. */
export const MIGRATIONS_SCHEMA = 'app';
export const MIGRATIONS_TABLE = '__drizzle_migrations';
/**
 * `apps/api/migrations`. `nest build` does not copy it; `src/database` and `dist/database` sit at
 * the same depth, so the path relative to this module holds for both.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

export interface MigrationFile {
  /** File name without `.sql`, as in `meta/_journal.json`. */
  tag: string;
  /** sha256 of the file bytes — the value the drizzle migrator records in the journal. */
  hash: string;
  folderMillis: number;
}

export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

type Queryable = pg.Pool | pg.ClientBase;

const JournalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});

/**
 * Tags of the migration files that have no journal record with the same hash. Timestamps are
 * deliberately ignored: the migrator skips a file timestamped before the last applied one, and
 * an edited applied file changes only its hash — both are pending.
 */
export function findPendingMigrations(
  files: readonly MigrationFile[],
  journal: readonly AppliedMigration[],
): string[] {
  const appliedHashes = new Set(journal.map((entry) => entry.hash));
  return files
    .filter((file) => !appliedHashes.has(file.hash))
    .map((file) => file.tag);
}

/** Migration files in journal order, hashed exactly as the drizzle migrator hashes them. */
function readMigrationFileList(
  folder: string = MIGRATIONS_FOLDER,
): MigrationFile[] {
  const { entries } = JournalSchema.parse(
    JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')),
  );
  // readMigrationFiles walks the same journal entries in the same order.
  return readMigrationFiles({ migrationsFolder: folder }).map(
    (meta, index) => ({
      tag: entries[index].tag,
      hash: meta.hash,
      folderMillis: meta.folderMillis,
    }),
  );
}

/** Journal records; none when the journal table does not exist yet. */
async function readAppliedMigrations(
  db: Queryable,
): Promise<AppliedMigration[]> {
  const table = await db.query<{ table: string | null }>(
    'SELECT to_regclass($1)::text AS "table"',
    [`"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`],
  );
  if (!table.rows[0].table) return [];
  const result = await db.query<{ hash: string; created_at: string | null }>(
    `SELECT hash, created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  );
  // node-postgres returns bigint `created_at` as a string.
  return result.rows.map((row) => ({
    hash: row.hash,
    createdAt: Number(row.created_at),
  }));
}

/** Throws, naming the files, when any migration file is not recorded in the journal. */
export async function assertNoPendingMigrations(
  db: Queryable,
  folder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const pending = findPendingMigrations(
    readMigrationFileList(folder),
    await readAppliedMigrations(db),
  );
  if (pending.length === 0) return;
  throw new Error(
    `Pending migrations (not in ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}): ` +
      `${pending.map((tag) => `${tag}.sql`).join(', ')}. ` +
      'Run `pnpm db:migrate`. If a file stays pending after it, its timestamp is not after the ' +
      'last applied migration: regenerate it so that it follows.',
  );
}
