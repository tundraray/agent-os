import { text } from 'node:stream/consumers';
import { ApiErrorSchema, type ApiError } from '@agent-os/contracts';
import { frontendOrigin, SESSION_COOKIE } from '../identity/session-cookie';

/**
 * The client of the running API shared by the operator scripts (`seed:mcp`, `seed:access`): the
 * administrator's session by login and a password from standard input, and JSON requests with it.
 * Errors name the step, the status and the API's error code — never the password, a key or the cookie.
 */

export const DEFAULT_API = 'http://localhost:4000';

/**
 * The fixture servers of the developer's registry: `seed:mcp` registers them — `shared` with the shared
 * token, `oauth` with personal OAuth — and `seed:access` allows them to the built-in role.
 */
export const SEED_MCP_SERVERS = {
  shared: ['logs', 'tracker'],
  oauth: 'backoffice',
} as const;

/** All of standard input without its trailing line break: the password never comes from the arguments. */
export async function readPassword(): Promise<string> {
  return (await text(process.stdin)).replace(/\r?\n$/, '');
}

/** The first `count` lines of standard input without their line breaks; a missing line is empty. */
export async function readLines(count: number): Promise<string[]> {
  const lines = (await text(process.stdin)).split(/\r?\n/);
  return Array.from({ length: count }, (_, index) => lines[index] ?? '');
}

/** The status and, for an error answer, its `ApiErrorSchema` body. */
export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly error: ApiError | undefined;
}

/** The failed step with the status and the API's error code and reason. */
export function stepFailed(
  step: string,
  answer: Omit<ApiAnswer, 'body'>,
): Error {
  const details = [answer.error?.errorCode, answer.error?.reason]
    .filter(Boolean)
    .join(' ');
  return new Error(`${step} answered ${answer.status} ${details}`.trim());
}

async function answerOf(response: Response): Promise<ApiAnswer> {
  const body: unknown =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  const error = response.ok ? undefined : ApiErrorSchema.safeParse(body).data;
  return { status: response.status, body, error };
}

/** The failed step of a raw `fetch` answer (a redirect step of a script). */
export async function failure(
  step: string,
  response: Response,
): Promise<Error> {
  return stepFailed(step, await answerOf(response));
}

/** The administrator's session on one API. */
export interface AdminSession {
  /** The `Cookie` header value of the session; a script sends it only to the API's origin. */
  readonly cookie: string;
  /** A JSON request to `<api><path>` with the session and the web's `Origin`. */
  request(method: string, path: string, body?: unknown): Promise<ApiAnswer>;
}

/** Signs the administrator in with `POST /api/auth/password` and keeps the session cookie. */
export async function signIn(
  api: string,
  login: string,
  password: string,
): Promise<AdminSession> {
  const response = await fetch(`${api}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: frontendOrigin() },
    body: JSON.stringify({ login, password }),
  });
  if (response.status !== 204) throw await failure('Sign-in', response);
  const cookie = response.headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  if (cookie === undefined) throw new Error('Sign-in set no session cookie');
  return {
    cookie,
    request: async (method, path, body) =>
      answerOf(
        await fetch(`${api}${path}`, {
          method,
          headers: {
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            origin: frontendOrigin(),
            cookie,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
}
