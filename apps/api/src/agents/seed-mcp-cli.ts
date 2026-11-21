import { parseArgs } from 'node:util';
import { McpErrorCode, type RegisterMcpServerBody } from '@agent-os/contracts';
// A devDependency in `src` on purpose: this is a developer tool, never run in the production image.
import { FIXTURE_SHARED_TOKEN } from '@agent-os/mcp-fixture';
import {
  DEFAULT_API,
  failure,
  readPassword,
  SEED_MCP_SERVERS,
  signIn,
  stepFailed,
  type AdminSession,
} from '../common/admin-cli-client';
import { createAppLogger } from '../logging/app-logger';

const logger = createAppLogger(process.env);

const DEFAULT_FIXTURE = 'http://localhost:4100';

interface Arguments {
  login: string;
  api: string;
  fixture: string;
}

/** `--login`, `--api`, `--fixture`; the password never comes from the arguments, only from stdin. */
function readArguments(): Arguments {
  const { values, positionals } = parseArgs({
    options: {
      login: { type: 'string' },
      api: { type: 'string', default: DEFAULT_API },
      fixture: { type: 'string', default: DEFAULT_FIXTURE },
    },
    // Collected rather than rejected by parseArgs: its error message would echo a password typed here.
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new Error(
      'Positional arguments are not accepted; the password is read from standard input',
    );
  }
  const { login, api, fixture } = values;
  if (!login) throw new Error('--login is required');
  return { login, api, fixture };
}

/** The fixture's servers: `logs` and `tracker` with the shared token, `backoffice` with personal OAuth. */
function fixtureServers(fixture: string): RegisterMcpServerBody[] {
  const shared = { mode: 'shared', sharedToken: FIXTURE_SHARED_TOKEN } as const;
  const { oauth } = SEED_MCP_SERVERS;
  return [
    ...SEED_MCP_SERVERS.shared.map((name) => ({
      name,
      url: `${fixture}/${name}/mcp`,
      ...shared,
    })),
    { name: oauth, url: `${fixture}/${oauth}/oauth/mcp`, mode: 'oauth' },
  ];
}

/** The `Location` of a redirect answer, or an error naming the step. */
async function redirectOf(step: string, response: Response): Promise<URL> {
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null) {
    throw await failure(step, response);
  }
  return new URL(location);
}

/** Registers `server`; false when the name is already taken (409), so a repeated run skips it. */
async function register(
  session: AdminSession,
  server: RegisterMcpServerBody,
): Promise<boolean> {
  const answer = await session.request(
    'POST',
    '/api/admin/mcp-servers',
    server,
  );
  if (answer.status === 201) return true;
  if (answer.error?.errorCode === McpErrorCode.MCP_SERVER_NAME_TAKEN)
    return false;
  throw stepFailed(`Registering ${server.name}`, answer);
}

/**
 * Connects the administrator's account on `server` as a browser would: `.../connect` → the fixture's
 * authorization address, which answers with a code at once → the API's return address of this server
 * (`/api/mcp/oauth/callback/<server>`, taken from the `Location`) with the session cookie, which must land on
 * `?connected=1`. Redirects are read, not followed, so the cookie goes only to the API.
 */
async function connectAdminAccount(
  api: string,
  cookie: string,
  server: string,
): Promise<void> {
  const authorization = await redirectOf(
    'Connect',
    await fetch(`${api}/api/admin/mcp-servers/${server}/connect`, {
      headers: { cookie },
      redirect: 'manual',
    }),
  );
  const callback = await redirectOf(
    'Fixture authorization',
    await fetch(authorization, { redirect: 'manual' }),
  );
  // The session cookie goes only to the API: an authorization server that returns elsewhere fails the run.
  if (callback.origin !== new URL(api).origin) {
    throw new Error(
      `Fixture authorization returned to ${callback.origin}, not to the API`,
    );
  }
  const landing = await redirectOf(
    'OAuth return',
    await fetch(callback, { headers: { cookie }, redirect: 'manual' }),
  );
  if (landing.searchParams.get('connected') !== '1') {
    const error = landing.searchParams.get('error') ?? 'no connected=1';
    throw new Error(`Connecting the account on ${server} failed: ${error}`);
  }
}

/**
 * Entry of `pnpm --filter api seed:mcp` (design-mcp-connect.md KD-7, UC-5; run from `dist`): a client of
 * the running API that registers the fixture servers in the developer's registry as the administrator
 * and connects his account on `backoffice`. Needs the fixture process (`pnpm --filter
 * @agent-os/mcp-fixture start`).
 */
async function main(): Promise<void> {
  const { login, api, fixture } = readArguments();
  const password = await readPassword();
  const session = await signIn(api, login, password);
  for (const server of fixtureServers(fixture)) {
    const startedAt = Date.now();
    const created = await register(session, server);
    if (created && server.mode === 'oauth') {
      await connectAdminAccount(api, session.cookie, server.name);
    }
    logger.info(
      created ? 'MCP server seeded' : 'MCP server skipped: name taken',
      {
        server: server.name,
        url: server.url,
        mode: server.mode,
        outcome: created ? 'registered' : 'skipped',
        login,
        durationMs: Date.now() - startedAt,
      },
    );
  }
}

try {
  await main();
} catch (error) {
  // Error messages carry steps, statuses and error codes only: no password, cookie or OAuth code.
  logger.error('seed:mcp failed', { error });
  process.exitCode = 1;
}
