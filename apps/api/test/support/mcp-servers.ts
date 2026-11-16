import type { Agents, McpServerWrite } from '@agent-os/agents';
import { McpError } from '@agent-os/agents';
import { McpErrorCode, type McpServerMode } from '@agent-os/contracts';
import {
  FIXTURE_SHARED_TOKEN,
  type FixtureProcess,
  type FixtureSource,
} from '@agent-os/mcp-fixture';
import { inject } from 'vitest';

/**
 * MCP servers of the tests in the registry (design-mcp-connect.md, KD-7). The tests run on the developer's
 * database, whose registry holds the developer's own `logs`, `backoffice` and `tracker` (`seed:mcp`), so a
 * test never registers those names: every server of a test run is `<source>-t<runId>`, where the suite's
 * global setup makes `runId` (six hex digits), hands it over through `provide`, and deletes the run's
 * servers (their accounts go with them) in its teardown.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    /** Six hex digits that end every MCP server name of this test run (`-t<runId>`). */
    mcpRunId: string;
  }
}

const RUN_SUFFIX = `-t${inject('mcpRunId')}`;

/** The run's name of a server: `<base>-t<runId>`. */
export function runName(base: string): string {
  return `${base}${RUN_SUFFIX}`;
}

/** The run's servers of the fixture sources: read-only payment logs, the back office with `create_incident_note`. */
export const LOGS_SERVER = runName('logs');
export const BACKOFFICE_SERVER = runName('backoffice');

/** The OAuth return address the tests register servers with; the tests never open it. */
const MCP_REDIRECT_URL = 'http://localhost:3000/api/mcp/oauth/callback';

/** The registry part of the package the helpers need. */
type McpOf = Pick<Agents, 'mcp'>;

export interface TestServer {
  readonly name: string;
  readonly url: string;
  readonly mode: McpServerMode;
  /** Required for `shared`. */
  readonly sharedToken?: string;
  /** {@link MCP_REDIRECT_URL} by default. */
  readonly redirectUrl?: string;
}

/** Deletes the server named `name` when the registry has it. */
async function removeServer(agents: McpOf, name: string): Promise<void> {
  try {
    await agents.mcp.remove(name);
  } catch (error) {
    if (!(
      error instanceof McpError &&
      error.code === McpErrorCode.MCP_SERVER_NOT_FOUND
    ))
      throw error;
  }
}

/**
 * Registers `server` through the registry (the server check included), replacing a row of the same name
 * left by an earlier harness of the run, which may point at a stopped fixture process.
 */
async function registerServer(
  agents: McpOf,
  server: TestServer,
): Promise<McpServerWrite> {
  await removeServer(agents, server.name);
  const common = {
    name: server.name,
    url: server.url,
    redirectUrl: server.redirectUrl ?? MCP_REDIRECT_URL,
  };
  if (server.mode === 'oauth')
    return agents.mcp.register({ ...common, mode: 'oauth' });
  if (server.sharedToken === undefined)
    throw new Error(`Shared server ${server.name} needs a shared token`);
  return agents.mcp.register({
    ...common,
    mode: 'shared',
    sharedToken: server.sharedToken,
  });
}

/** Registers the run's server of each source at the fixture process's shared-token path. */
export async function registerFixtureServers(
  agents: McpOf,
  fixture: FixtureProcess,
  sources: readonly FixtureSource[],
): Promise<void> {
  for (const source of sources) {
    await registerServer(agents, {
      name: runName(source),
      url: fixture.sharedUrl(source),
      mode: 'shared',
      sharedToken: FIXTURE_SHARED_TOKEN,
    });
  }
}
