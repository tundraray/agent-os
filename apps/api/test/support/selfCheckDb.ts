import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  applyMigrations,
  createDatabase,
  type DatabaseConnection,
  researchAgentMessages,
  researchAgentRuns,
  researchAgentToolCalls,
  researchEngineRuns,
  researchInvestigations,
  researchLlmCalls,
  researchLlmTranscripts,
} from '@agent-os/db';
import type { AgentTree, Engine } from '@agent-os/engine';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { SELF_CHECK_OWNER } from '../../src/auth/system-owners.js';
import { assertTestDatabase } from './testDatabaseGuard.js';

/**
 * Databases of the self-check test files (design-self-check.md, Test Strategy): a migrated scratch database per file —
 * the `DATABASE_URL` the program under test shares with the employees' investigations the test saves there, as it
 * shares the server's database (KD-3) — created and dropped here, and read-only snapshots of its `research_*` tables.
 * A scratch database keeps the program's cancel of `system:self-check` leftovers and the runtime workers of a test away
 * from the suite's database, which other files use. The creation repeats the pattern of
 * `packages/db/test/support/scratch-db.ts`, which `apps/api` may not import (plan rule 11). Apart from
 * `CREATE DATABASE`, the migrations and `DROP DATABASE`, nothing here writes: every read is a `SELECT`.
 */

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

/** `DATABASE_URL` of the suite: the process environment first, otherwise `apps/api/.env`. Scratch databases live on its server. */
function suiteDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  assertTestDatabase(url, 'self-check E2E');
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
  const url = new URL(suiteDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Scratch databases on the server of the suite's `DATABASE_URL`, one set per test file; {@link dropAll} removes them in
 * `afterAll`.
 */
export class ScratchDatabases {
  private readonly names: string[] = [];

  /**
   * A new database with the migrations applied, as the server's database is; returns its URL. Employees'
   * investigations can be saved in it before the program starts, and the program's own start finds nothing to migrate.
   */
  async create(): Promise<string> {
    const name = `e2e_${randomBytes(6).toString('hex')}`;
    await withConnection(suiteDatabaseUrl(), (client) =>
      client.query(`CREATE DATABASE "${name}"`),
    );
    this.names.push(name);
    const url = urlOfDatabase(name);
    await applyMigrations(url);
    return url;
  }

  /** Drops every database this instance created; closes the snapshot pools first. */
  async dropAll(): Promise<void> {
    await closeSelfCheckDb();
    const names = this.names.splice(0);
    await withConnection(suiteDatabaseUrl(), async (client) => {
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

export type AgentRunRow = typeof researchAgentRuns.$inferSelect;
export type AgentToolCallRow = typeof researchAgentToolCalls.$inferSelect;
export type AgentMessageRow = typeof researchAgentMessages.$inferSelect;

/** The agent runs of the investigation, oldest first. */
export function agentRunsOf(
  url: string,
  investigationId: string,
): Promise<AgentRunRow[]> {
  return connection(url)
    .db.select()
    .from(researchAgentRuns)
    .where(eq(researchAgentRuns.investigationId, investigationId))
    .orderBy(asc(researchAgentRuns.createdAt), asc(researchAgentRuns.taskId));
}

/** The tool calls of the investigation's agent runs, in the order they were requested. */
export function agentToolCallsOf(
  url: string,
  investigationId: string,
): Promise<AgentToolCallRow[]> {
  return connection(url)
    .db.select()
    .from(researchAgentToolCalls)
    .where(eq(researchAgentToolCalls.investigationId, investigationId))
    .orderBy(
      asc(researchAgentToolCalls.createdAt),
      asc(researchAgentToolCalls.callIndex),
    );
}

/** The session messages of the investigation's agent runs, in the order they were written. */
export function agentMessagesOf(
  url: string,
  investigationId: string,
): Promise<AgentMessageRow[]> {
  return connection(url)
    .db.select()
    .from(researchAgentMessages)
    .where(eq(researchAgentMessages.investigationId, investigationId))
    .orderBy(asc(researchAgentMessages.createdAt));
}

/** The investigation's agent tree as its owner reads it, through the engine of a scenario assembly. */
export async function agentTreeOf(
  engine: Pick<Engine, 'readAgentTree'>,
  investigation: {
    readonly investigationId: string;
    readonly resourceId: string;
  },
): Promise<AgentTree> {
  const read = await engine.readAgentTree(investigation);
  if (read.outcome !== 'found') {
    throw new Error(
      `selfCheckDb: no agent tree of ${investigation.investigationId}: ${read.outcome}`,
    );
  }
  return read.tree;
}

/** The `research_*` tables of the `app` schema with an `investigation_id` column, by name. */
async function investigationTables(url: string): Promise<string[]> {
  const result = await connection(url).pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name LIKE 'research\\_%' AND column_name = 'investigation_id'
      ORDER BY table_name`,
  );
  return result.rows.map((row) => row.name);
}

/**
 * The version of every row bound to an employee's investigation — an investigation of any owner but `system:self-check`
 * — in every `research_*` table that names its investigation: `<table> <ctid>` → `xmin`. An insert, an update or a
 * delete of such a row changes the map, so two equal snapshots mean the program wrote nothing of the employees'
 * (invariant 5); the program's own rows in the same database are left out.
 */
export async function employeeRowVersions(
  url: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const { pool } = connection(url);
  for (const table of await investigationTables(url)) {
    const result = await pool.query<{ row: string; version: string }>(
      `SELECT ctid::text AS row, xmin::text AS version FROM app."${table}"
        WHERE investigation_id IN (
          SELECT investigation_id FROM app.research_investigations WHERE resource_id <> $1
        )`,
      [SELF_CHECK_OWNER],
    );
    for (const { row, version } of result.rows) {
      versions.set(`${table} ${row}`, version);
    }
  }
  return versions;
}
