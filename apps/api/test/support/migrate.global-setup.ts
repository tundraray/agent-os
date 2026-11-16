import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { applyMigrations, createDatabase } from '@agent-os/db';
import type { TestProject } from 'vitest/node';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

/** `DATABASE_URL` as the app sees it: the process environment first, otherwise `apps/api/.env`. */
export function databaseUrl(): string {
  const url =
    process.env.DATABASE_URL ??
    parseEnv(readFileSync(ENV_FILE, 'utf8')).DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/**
 * Vitest global setup of the e2e suite: applies migrations once, before any test file boots the
 * app (whose start fails on pending migrations), through the same function as `pnpm db:migrate`;
 * hands the tests the run id of their MCP server, model and role names (`mcp-servers.ts`, `access.ts`),
 * and its teardown deletes what a suite of the run left: the servers (their accounts go with them), the
 * models (their grants go with them) and the roles (their members and grants go with them), so the
 * developer's registry, catalogue and roles keep only his own rows.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  await applyMigrations(databaseUrl());
  const runId = randomBytes(3).toString('hex');
  project.provide('mcpRunId', runId);
  return async () => {
    const database = createDatabase({
      connectionString: databaseUrl(),
      poolMax: 1,
    });
    try {
      const runRows = `%-t${runId}`;
      await database.pool.query(
        'DELETE FROM app.agent_mcp_servers WHERE name LIKE $1',
        [runRows],
      );
      await database.pool.query(
        'DELETE FROM app.access_models WHERE id LIKE $1',
        [`anthropic/${runRows}`],
      );
      await database.pool.query(
        'DELETE FROM app.identity_roles WHERE name LIKE $1 AND NOT builtin',
        [runRows],
      );
    } finally {
      await database.close();
    }
  };
}
