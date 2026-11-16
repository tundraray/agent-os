import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import {
  McpErrorCode,
  type ApiError,
  type RegisterMcpServerBody,
} from '@agent-os/contracts';
// A devDependency in `src` on purpose: this is a developer tool, never run in the production image.
import { FIXTURE_SHARED_TOKEN } from '@agent-os/mcp-fixture';
import { frontendOrigin, SESSION_COOKIE } from '../identity/session-cookie.js';
import { createAppLogger } from '../logging/app-logger.js';

const logger = createAppLogger(process.env);

const DEFAULT_API = 'http://localhost:4000';
const DEFAULT_FIXTURE = 'http://localhost:4100';

/** The OAuth server whose account the administrator connects after registering it. */
const OAUTH_SERVER = 'backoffice';

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

/** All of standard input without its trailing line break. */
async function readPassword(): Promise<string> {
  return (await text(process.stdin)).replace(/\r?\n$/, '');
}

/** The fixture's servers: `logs` and `tracker` with the shared token, `backoffice` with personal OAuth. */
function fixtureServers(fixture: string): RegisterMcpServerBody[] {
  const shared = { mode: 'shared', sharedToken: FIXTURE_SHARED_TOKEN } as const;
  return [
    { name: 'logs', url: `${fixture}/logs/mcp`, ...shared },
    { name: 'tracker', url: `${fixture}/tracker/mcp`, ...shared },
    {
      name: OAUTH_SERVER,
      url: `${fixture}/backoffice/oauth/mcp`,
      mode: 'oauth',
    },
  ];
}

/** The failed step with the status and the API's error code; never a header or a cookie. */
async function failure(step: string, response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as Partial<ApiError>;
  const details = [body.errorCode, body.reason].filter(Boolean).join(' ');
  return new Error(`${step} answered ${response.status} ${details}`.trim());
}

/** The `Location` of a redirect answer, or an error naming the step. */
async function redirectOf(step: string, response: Response): Promise<URL> {
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null) {
    throw await failure(step, response);
  }
  return new URL(location);
}

/** A session of the administrator: `POST /api/auth/password`, the `Cookie` header value of its session. */
async function signIn(
  api: string,
  login: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${api}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: frontendOrigin() },
    body: JSON.stringify({ login, password }),
  });
  if (response.status !== 204) throw await failure('Sign-in', response);
  const session = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  if (session === undefined) throw new Error('Sign-in set no session cookie');
  return session;
}

/** Registers `server`; false when the name is already taken (409), so a repeated run skips it. */
async function register(
  api: string,
  cookie: string,
  server: RegisterMcpServerBody,
): Promise<boolean> {
  const response = await fetch(`${api}/api/admin/mcp-servers`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: frontendOrigin(),
      cookie,
    },
    body: JSON.stringify(server),
  });
  if (response.status === 201) return true;
  if (response.status === 409) {
    const body = (await response.json()) as Partial<ApiError>;
    if (body.errorCode === McpErrorCode.MCP_SERVER_NAME_TAKEN) return false;
  }
  throw await failure(`Registering ${server.name}`, response);
}

/**
 * Connects the administrator's account on `server` as a browser would: `.../connect` → the fixture's
 * authorization address, which answers with a code at once → the API's return with the session cookie,
 * which must land on `?connected=1`. Redirects are read, not followed, so the cookie goes only to the API.
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
  const cookie = await signIn(api, login, password);
  for (const server of fixtureServers(fixture)) {
    const startedAt = Date.now();
    const created = await register(api, cookie, server);
    if (created && server.mode === 'oauth') {
      await connectAdminAccount(api, cookie, server.name);
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
