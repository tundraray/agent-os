import { inject } from 'vitest';

/**
 * Names of the test run in the registries shared with the developer (design-mcp-connect.md, KD-7). The tests
 * run on the developer's database, whose registry holds the developer's own `logs`, `backoffice` and `tracker`
 * (`seed:mcp`), so a test never registers those names: every server of a test run is `<source>-t<runId>`,
 * where the suite's global setup makes `runId` (six hex digits), hands it over through `provide`, and deletes
 * the run's rows in its teardown. The registry helpers are those of `@agent-os/agents/testing`; the names stay
 * here, because they are read from Vitest when the file loads and the testing entry is loaded by child
 * processes outside Vitest.
 */

const RUN_SUFFIX = `-t${inject('mcpRunId')}`;

/** The run's name of a server: `<base>-t<runId>`. */
export function runName(base: string): string {
  return `${base}${RUN_SUFFIX}`;
}

/** The run's servers of the fixture sources: read-only payment logs, the back office with `create_incident_note`. */
export const LOGS_SERVER = runName('logs');
export const BACKOFFICE_SERVER = runName('backoffice');
