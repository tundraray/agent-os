import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { TestProject } from 'vitest/node';

import { createDatabase, type DatabaseConnection } from './database';
import { applyMigrations } from './migrate';

/**
 * Test support of the Postgres suites of every package (`@agent-os/db/testing`): the database address, a
 * test-unique employee, the Vitest global setups and the polling wait. The child processes of the tests load
 * this file under plain `tsx`, outside Vitest: it imports nothing of Vitest but types.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    /** Six hex digits that end every shared-registry name of this test run (`-t<runId>`). */
    mcpRunId: string;
  }
}

/**
 * `.env` of the composition root, the file the developer already keeps for `apps/api`. Resolved
 * from the source location; a child process gets `DATABASE_URL` from its harness and never
 * reaches this fallback.
 */
const ENV_FILE = fileURLToPath(
  new URL('../../../apps/api/.env', import.meta.url),
);

/** Polling of {@link waitFor}. */
const SETTLE_POLL_MS = 25;

/**
 * `DATABASE_URL` of the tests: the process environment first, otherwise `apps/api/.env`.
 * The only place in the tests that reads it (ADR-0004: settings reach `src` as parameters).
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? readEnvFile().DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/** Variables of {@link ENV_FILE}; none when the file does not exist (CI sets the environment). */
function readEnvFile(): Record<string, string | undefined> {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseEnv(text);
}

/**
 * A fresh, test-unique employee: inserts an `identity_users` row with a unique email and login over a short
 * connection and returns its id, so an owner column's foreign key accepts it (data-model design-schema.md KD-4).
 * Rows of one test never meet another test's.
 */
export async function newUser(): Promise<string> {
  const unique = `e2e-${randomUUID()}`;
  const database = createDatabase({
    connectionString: databaseUrl(),
    poolMax: 1,
  });
  try {
    const { rows } = await database.pool.query<{ id: string }>(
      'insert into app.identity_users (email, login) values ($1, $2) returning id',
      [`${unique}@test.local`, unique],
    );
    return rows[0].id;
  } finally {
    await database.close();
  }
}

/**
 * Vitest global setup of a Postgres suite: applies migrations once, before any test file runs,
 * through the same function as `pnpm db:migrate`.
 */
export async function migrate(): Promise<void> {
  await applyMigrations(databaseUrl());
}

/**
 * Vitest global setup of a suite that writes rows into registries shared with the developer (MCP
 * servers, model providers, models, roles): {@link migrate}, then hands the tests the run id their names
 * end with (`inject('mcpRunId')`, `<name>-t<runId>`); its teardown calls `removeRunRows` with the `LIKE`
 * pattern of those names (`%-t<runId>`), so the developer's database keeps only his own rows.
 */
export function migrateForRun(
  removeRunRows: (
    pool: DatabaseConnection['pool'],
    runRows: string,
  ) => Promise<unknown>,
): (project: TestProject) => Promise<() => Promise<void>> {
  return async (project) => {
    await migrate();
    const runId = randomBytes(3).toString('hex');
    project.provide('mcpRunId', runId);
    return async () => {
      const database = createDatabase({
        connectionString: databaseUrl(),
        poolMax: 1,
      });
      try {
        await removeRunRows(database.pool, `%-t${runId}`);
      } finally {
        await database.close();
      }
    };
  };
}

/**
 * Polls `read` until `done` holds and returns that value; fails naming `what` and the last value
 * after `timeoutMs`. Tests synchronise on rows and latches with it, never on sleeps.
 */
export async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(
          value instanceof Map ? [...value] : value,
        )}`,
      );
    }
    await delay(SETTLE_POLL_MS);
    value = await read();
  }
  return value;
}
