import type { AgentsMcp, McpConnectResult } from '@agent-os/agents';
import { mcpRedirectUrl } from '@agent-os/agents/testing';
import { inject } from 'vitest';

/**
 * MCP servers of the tests in the registry (design-mcp-connect.md, KD-7). The tests run on the developer's
 * database, whose registry holds the developer's own `logs`, `backoffice` and `tracker` (`seed:mcp`), so a
 * test never registers those names: every server of a test run is `<source>-t<runId>`, where the suite's
 * global setup makes `runId` (six hex digits), hands it over through `provide`, and deletes the run's
 * servers (their accounts go with them) in its teardown. The registry helpers are those of
 * `@agent-os/agents/testing`; the names stay here, because they are read from Vitest when the file loads and
 * the testing entry is loaded by child processes outside Vitest.
 */

const RUN_SUFFIX = `-t${inject('mcpRunId')}`;

/** The run's name of a server: `<base>-t<runId>`. */
export function runName(base: string): string {
  return `${base}${RUN_SUFFIX}`;
}

/** The run's servers of the fixture sources: read-only payment logs, the back office with `create_incident_note`, the tracker. */
export const LOGS_SERVER = runName('logs');
export const BACKOFFICE_SERVER = runName('backoffice');
export const TRACKER_SERVER = runName('tracker');

/** The registry part of the package the helpers need. */
interface McpOf {
  readonly mcp: AgentsMcp;
}

/**
 * Connects the account of `ownerId` on the `oauth` server `server` as a browser would: `beginConnect`, the
 * authorization address opened with `fixture_account` (the fixture signs that account in and redirects at
 * once; the redirect is read, not followed), then `finishConnect` with the server of the redirect's path and
 * its `code`, `state` and `iss`. With `isAdmin` the connection is the admin's account of the server.
 */
export async function connectAccount(
  harness: { readonly agents: McpOf },
  ownerId: string,
  server: string,
  options: { readonly account: string; readonly isAdmin?: boolean },
): Promise<McpConnectResult> {
  const isAdmin = options.isAdmin ?? false;
  const begun = await harness.agents.mcp.beginConnect({
    ownerId,
    server,
    target: isAdmin ? 'admin' : 'employee',
    redirectUrl: mcpRedirectUrl(server),
  });
  if (begun.kind !== 'redirect')
    throw new Error(`Connecting ${ownerId} to ${server} was refused`);
  const authorizationUrl = new URL(begun.authorizationUrl);
  authorizationUrl.searchParams.set('fixture_account', options.account);
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location === null) {
    throw new Error(
      `The authorization address answered ${response.status} without a redirect`,
    );
  }
  const returned = new URL(location);
  const back = returned.searchParams;
  return harness.agents.mcp.finishConnect({
    ownerId,
    isAdmin,
    server: decodeURIComponent(returned.pathname.split('/').at(-1) ?? ''),
    state: back.get('state') ?? '',
    ...optionalParam(back, 'code'),
    ...optionalParam(back, 'iss'),
    ...optionalParam(back, 'error'),
  });
}

function optionalParam<Name extends string>(
  params: URLSearchParams,
  name: Name,
): Partial<Record<Name, string>> {
  const value = params.get(name);
  return value === null ? {} : ({ [name]: value } as Record<Name, string>);
}
