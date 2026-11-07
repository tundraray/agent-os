import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  type DatabaseConnection,
  researchEngineRuns,
  researchInvestigations,
  researchLlmCalls,
  researchLlmTranscripts,
} from '@agent-os/db';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';

/**
 * Databases of the self-check integration file (design-self-check.md, Test Strategy): a scratch database per file whose
 * name ends in `_self_check`, created and dropped here, and read-only snapshots of the `research_*` tables of both
 * databases. The creation repeats the pattern of `packages/db/test/support/scratch-db.ts`, which `apps/api` may not
 * import (plan rule 11) and whose names lack the suffix the program's guard requires. Apart from `CREATE DATABASE` and
 * `DROP DATABASE`, nothing here writes: the program migrates its database itself, and every read is a `SELECT`.
 */

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
/** The suffix the program's guard requires of its database name (DC-17). */
const SELF_CHECK_SUFFIX = '_self_check';

/** `DATABASE_URL` as the app sees it: the process environment first, otherwise `apps/api/.env`. */
export function mainDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/** Runs `use` on a dedicated connection to `url`, closed afterwards. */
async function withConnection<T>(
  url: string,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

function urlOfDatabase(name: string): string {
  const url = new URL(mainDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Empty databases on the server of `DATABASE_URL`, one set per test file: the program under test migrates the one it
 * is given, never the main one; {@link dropAll} removes them in `afterAll`.
 */
export class SelfCheckDatabases {
  private readonly names: string[] = [];

  /**
   * A new empty database; returns its URL. Its name ends in `_self_check` unless `selfCheckSuffix` is false — a
   * database the guard must refuse (INT-5 R1).
   */
  async create(options: { selfCheckSuffix?: boolean } = {}): Promise<string> {
    const suffix = options.selfCheckSuffix === false ? '' : SELF_CHECK_SUFFIX;
    const name = `e2e_${randomBytes(6).toString('hex')}${suffix}`;
    await withConnection(mainDatabaseUrl(), (client) =>
      client.query(`CREATE DATABASE "${name}"`),
    );
    this.names.push(name);
    return urlOfDatabase(name);
  }

  /** Drops every database this instance created; closes the snapshot pools first. */
  async dropAll(): Promise<void> {
    await closeSelfCheckDb();
    const names = this.names.splice(0);
    await withConnection(mainDatabaseUrl(), async (client) => {
      for (const name of names) {
        // FORCE: a connection of a failed test may still be closing.
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Read-only snapshots
// ---------------------------------------------------------------------------------------------

const pools = new Map<string, DatabaseConnection>();

function connection(url: string): DatabaseConnection {
  let opened = pools.get(url);
  if (opened === undefined) {
    opened = createDatabase({ connectionString: url, poolMax: 2 });
    pools.set(url, opened);
  }
  return opened;
}

/** Closes the snapshot pools of every database read so far; call from `afterAll`. */
async function closeSelfCheckDb(): Promise<void> {
  const opened = [...pools.values()];
  pools.clear();
  await Promise.all(opened.map((database) => database.close()));
}

export type InvestigationRow = typeof researchInvestigations.$inferSelect;
export type EngineRunRow = typeof researchEngineRuns.$inferSelect;
export type LlmCallRow = typeof researchLlmCalls.$inferSelect;
export type TranscriptRow = typeof researchLlmTranscripts.$inferSelect;

/** Every investigation of `resourceId` in the database of `url`, oldest first. */
export function investigationsOf(
  url: string,
  resourceId: string,
): Promise<InvestigationRow[]> {
  return connection(url)
    .db.select()
    .from(researchInvestigations)
    .where(eq(researchInvestigations.resourceId, resourceId))
    .orderBy(
      asc(researchInvestigations.createdAt),
      asc(researchInvestigations.investigationId),
    );
}

/** The engine row of the investigation (slice, frozen configuration, answer), or `undefined`. */
export async function engineRunOf(
  url: string,
  investigationId: string,
): Promise<EngineRunRow | undefined> {
  const [row] = await connection(url)
    .db.select()
    .from(researchEngineRuns)
    .where(eq(researchEngineRuns.investigationId, investigationId));
  return row;
}

/** The call journal of the investigation in call order: steps, tokens and cost are summed from it. */
export function llmCallsOf(
  url: string,
  investigationId: string,
): Promise<LlmCallRow[]> {
  return connection(url)
    .db.select()
    .from(researchLlmCalls)
    .where(eq(researchLlmCalls.investigationId, investigationId))
    .orderBy(asc(researchLlmCalls.createdAt), asc(researchLlmCalls.callId));
}

/**
 * Transcripts bound to an investigation or to a self-check run identifier (`self-check:run:…`, `self-check:show:…`),
 * in call order, as stored.
 */
export function transcriptsOf(
  url: string,
  binding:
    { readonly investigationId: string } | { readonly selfCheckRunId: string },
): Promise<TranscriptRow[]> {
  const where =
    'investigationId' in binding
      ? eq(researchLlmTranscripts.investigationId, binding.investigationId)
      : eq(researchLlmTranscripts.selfCheckRunId, binding.selfCheckRunId);
  return connection(url)
    .db.select()
    .from(researchLlmTranscripts)
    .where(where)
    .orderBy(
      asc(researchLlmTranscripts.createdAt),
      asc(researchLlmTranscripts.callId),
    );
}

/** The `research_*` tables of the `app` schema, by name: an unmigrated database has none. */
async function researchTables(url: string): Promise<string[]> {
  const result = await connection(url).pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'app' AND table_name LIKE 'research\\_%'
      ORDER BY table_name`,
  );
  return result.rows.map((row) => row.name);
}

/**
 * The version of every row of every `research_*` table: `<table> <ctid>` → `xmin`. An insert, an update or a delete
 * anywhere changes the map, so two equal snapshots mean nothing in those tables was written in between ("nothing
 * changed" checks of the main database, invariant 5).
 */
export async function researchRowVersions(
  url: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const { pool } = connection(url);
  for (const table of await researchTables(url)) {
    const result = await pool.query<{ row: string; version: string }>(
      `SELECT ctid::text AS row, xmin::text AS version FROM app."${table}"`,
    );
    for (const { row, version } of result.rows) {
      versions.set(`${table} ${row}`, version);
    }
  }
  return versions;
}
