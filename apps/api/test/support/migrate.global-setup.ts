import { migrateForRun } from '@agent-os/db/testing';

/**
 * Vitest global setup of the e2e suite: migrations once, before any test file boots the app (whose start
 * fails on pending migrations), and the run id of the MCP server, model provider, model and role names
 * (`mcp-servers.ts`, `access.ts`). Its teardown deletes what a suite of the run left: the servers (their
 * accounts go with them), the models (their grants go with them, a default model pointing at one becomes
 * `null`), the model providers (`run-t<runId>`, `run-embed-t<runId>`: the one place that removes them) and
 * the roles (their members and grants go with them), so the developer's registry, providers, catalogue and
 * roles keep only his own rows.
 */
export default migrateForRun(async (pool, runRows) => {
  await pool.query('DELETE FROM app.mcp_servers WHERE name LIKE $1', [runRows]);
  await pool.query('DELETE FROM app.models WHERE id LIKE $1', [`${runRows}/%`]);
  await pool.query('DELETE FROM app.model_providers WHERE name LIKE $1', [
    runRows,
  ]);
  await pool.query(
    'DELETE FROM app.identity_roles WHERE name LIKE $1 AND NOT builtin',
    [runRows],
  );
});
