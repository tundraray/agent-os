import { randomBytes } from 'node:crypto';
import { applyMigrations, createDatabase } from '@agent-os/db';
import type { TestProject } from 'vitest/node';
import { databaseUrl } from './database-url.js';

/**
 * Vitest global setup of the package's Postgres suites: applies migrations once, before any test
 * file builds a runtime, through the same function as `pnpm db:migrate`; hands the tests the run id of
 * their MCP server names (`mcp-servers.ts`), and its teardown deletes the servers of the run — their
 * accounts go with them — so the developer's registry keeps only its own servers.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await applyMigrations(databaseUrl());
  const runId = randomBytes(3).toString('hex');
  project.provide('mcpRunId', runId);
  return async () => {
    const database = createDatabase({ connectionString: databaseUrl(), poolMax: 1 });
    try {
      await database.pool.query('DELETE FROM app.agent_mcp_servers WHERE name LIKE $1', [`%-t${runId}`]);
    } finally {
      await database.close();
    }
  };
}
