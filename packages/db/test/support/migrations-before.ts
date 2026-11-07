import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { z } from 'zod';
import {
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from '../../src/index.js';

const JournalSchema = z.looseObject({
  entries: z.array(z.looseObject({ tag: z.string() })),
});

/**
 * Brings a database to the state just before the migration `tag`: applies a copy of
 * `MIGRATIONS_FOLDER` whose journal ends right before that entry. The cut is by tag, not by
 * count, so migrations added after `tag` do not move it. A later `applyMigrations` with the full
 * folder then applies `tag` and everything after it.
 */
export async function applyMigrationsBefore(
  databaseUrl: string,
  tag: string,
): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'migrations-before-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JournalSchema.parse(
      JSON.parse(readFileSync(journalPath, 'utf8')),
    );
    const cut = journal.entries.findIndex((entry) => entry.tag === tag);
    if (cut < 0) {
      throw new Error(`Migration ${tag} is not in ${MIGRATIONS_FOLDER}`);
    }
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }),
    );

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await migrate(drizzle({ client }), {
        migrationsFolder: folder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      await client.end();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
