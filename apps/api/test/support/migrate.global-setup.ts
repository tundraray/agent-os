import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { applyMigrations, createDatabase } from '@agent-os/db';
import type { TestProject } from 'vitest/node';

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
 * app (whose start fails on pending migrations), through the same function as `pnpm db:migrate`;
 * hands the tests the run id of their MCP server names (`mcp-servers.ts`), and its teardown deletes
 * the servers of the run — their accounts go with them — so the developer's registry keeps only its
 * own servers.
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
      await database.pool.query(
        'DELETE FROM app.agent_mcp_servers WHERE name LIKE $1',
        [`%-t${runId}`],
      );
    } finally {
      await database.close();
    }
  };
}
