import { migrateForRun } from '@agent-os/db/testing';

/**
 * Vitest global setup of the package's Postgres suites: migrations once, before any test file builds a
 * runtime, and the run id of the MCP server names (`mcp-servers.ts`); its teardown deletes the servers of
 * the run — their accounts go with them — so the developer's registry keeps only its own servers.
 */
export default migrateForRun((pool, runRows) =>
  pool.query('DELETE FROM app.agent_mcp_servers WHERE name LIKE $1', [runRows]),
);
