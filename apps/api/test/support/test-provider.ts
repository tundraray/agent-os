import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One OIDC issuer in the test process (design-identity.md, Test Strategy): discovery, `authorize`, `token`
 * and JWKS on `http://localhost:<port>` (the API accepts `http` only for a `localhost` issuer). The ID
 * token is RS256 with `aud` = the client id, `iss` = the issuer and the request's `nonce`; the token call
 * checks the code, the redirect URI and PKCE (S256). The issuer does not know the client secrets: it records
 * the `client_id` and secret each token call carried (`client_secret_basic`), and the test checks them.
 */

/** What the employee "does" at the provider for one sign-in. */
export type ProviderAnswer =
  /** Signs in: the ID token carries these claims; no `email` gives the email-less variant. */
  | { email?: string; name?: string; groups?: unknown }
  /** Refuses or fails at the provider: the callback gets `error` (`access_denied` = cancelled). */
  | { error: string };

/** The client authentication of one token call, as the issuer received it. */
export interface TokenCall {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface TestProvider {
  /** `http://localhost:<port>`, exactly as the discovery document names it. */
  readonly issuer: string;
  /** Every token call so far, in order. */
  readonly tokenCalls: readonly TokenCall[];
  /**
   * Opens the API's authorization URL (the `Location` of `GET /api/auth/sign-in/:providerId`) as the
   * employee giving `answer`, and returns the callback URL the provider redirects to.
   */
  authorize(authorizationUrl: string, answer: ProviderAnswer): Promise<URL>;
  close(): Promise<void>;
}

/** The header carrying the test's `ProviderAnswer` to `authorize` (a browser would carry a provider session). */
const ANSWER_HEADER = 'x-test-answer';

/** Seconds an issued ID token is valid. */
const ID_TOKEN_TTL_SECONDS = 300;

/** An issued code, until the token call uses it. */
interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  answer: { email?: string; name?: string; groups?: unknown };
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
}

class BadRequest extends Error {}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

/** One part of `client_secret_basic`: form-url-encoded before base64 (RFC 6749 §2.3.1). */
function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

function createSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = randomUUID();
  return {
    kid,
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: 'jwk' }),
      kid,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

function signJwt(key: SigningKey, claims: Record<string, unknown>): string {
  const header = base64url(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }),
  );
  const payload = base64url(JSON.stringify(claims));
  const signature = sign(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    key.privateKey,
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: URL): void {
  response.writeHead(302, { location: location.href });
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value === '') throw new BadRequest(`missing ${name}`);
  return value;
}

function parseAnswer(header: string | string[] | undefined): ProviderAnswer {
  if (typeof header !== 'string')
    throw new BadRequest(`missing ${ANSWER_HEADER}`);
  return JSON.parse(header) as ProviderAnswer;
}

/** `client_id` and secret of the `Authorization: Basic` header. */
function basicCredentials(header: string | undefined): TokenCall {
  if (header === undefined || !header.startsWith('Basic '))
    throw new BadRequest('no basic authentication');
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString(
    'utf8',
  );
  const colon = decoded.indexOf(':');
  if (colon === -1) throw new BadRequest('malformed basic authentication');
  return {
    clientId: formDecode(decoded.slice(0, colon)),
    clientSecret: formDecode(decoded.slice(colon + 1)),
  };
}

function pkceChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Starts the issuer on a free port of `localhost`. */
export async function startTestProvider(): Promise<TestProvider> {
  const key = createSigningKey();
  const codes = new Map<string, IssuedCode>();
  const tokenCalls: TokenCall[] = [];
  let issuer = '';

  const discovery = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    scopes_supported: ['openid', 'email', 'profile'],
  });

  /** 302 to the client's `redirect_uri` with a code (or the answer's `error`) and the `state`. */
  function authorize(
    request: IncomingMessage,
    params: URLSearchParams,
    response: ServerResponse,
  ): void {
    if (required(params, 'response_type') !== 'code')
      throw new BadRequest('response_type must be code');
    if (required(params, 'code_challenge_method') !== 'S256')
      throw new BadRequest('PKCE must be S256');
    const redirectUri = required(params, 'redirect_uri');
    const back = new URL(redirectUri);
    back.searchParams.set('state', required(params, 'state'));
    const answer = parseAnswer(request.headers[ANSWER_HEADER]);
    if ('error' in answer) {
      back.searchParams.set('error', answer.error);
      redirect(response, back);
      return;
    }
    const code = base64url(randomBytes(24));
    codes.set(code, {
      clientId: required(params, 'client_id'),
      redirectUri,
      codeChallenge: required(params, 'code_challenge'),
      nonce: required(params, 'nonce'),
      answer,
    });
    back.searchParams.set('code', code);
    redirect(response, back);
  }

  /** Exchanges a code once: records the client authentication, checks the code, redirect URI and PKCE. */
  async function token(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const call = basicCredentials(request.headers.authorization);
    tokenCalls.push(call);
    const form = new URLSearchParams(await readBody(request));
    if (required(form, 'grant_type') !== 'authorization_code')
      throw new BadRequest('unsupported grant_type');
    const code = required(form, 'code');
    const issued = codes.get(code);
    codes.delete(code);
    if (
      issued === undefined ||
      issued.clientId !== call.clientId ||
      issued.redirectUri !== form.get('redirect_uri') ||
      issued.codeChallenge !== pkceChallengeOf(required(form, 'code_verifier'))
    ) {
      sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const { email, name, groups } = issued.answer;
    const idToken = signJwt(key, {
      iss: issuer,
      sub: email ?? randomUUID(),
      aud: issued.clientId,
      iat: now,
      exp: now + ID_TOKEN_TTL_SECONDS,
      nonce: issued.nonce,
      ...(email === undefined ? {} : { email, email_verified: true }),
      ...(name === undefined ? {} : { name }),
      ...(groups === undefined ? {} : { groups }),
    });
    sendJson(response, 200, {
      access_token: base64url(randomBytes(24)),
      token_type: 'Bearer',
      expires_in: ID_TOKEN_TTL_SECONDS,
      id_token: idToken,
    });
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', issuer);
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /.well-known/openid-configuration')
      sendJson(response, 200, discovery());
    else if (route === 'GET /jwks')
      sendJson(response, 200, { keys: [key.publicJwk] });
    else if (route === 'GET /authorize')
      authorize(request, url.searchParams, response);
    else if (route === 'POST /token') await token(request, response);
    else sendJson(response, 404, { error: 'not_found' });
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const invalid =
        error instanceof BadRequest || error instanceof SyntaxError;
      sendJson(response, invalid ? 400 : 500, {
        error: invalid ? 'invalid_request' : 'server_error',
        error_description:
          error instanceof Error ? error.message : String(error),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  issuer = `http://localhost:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    tokenCalls,
    authorize: async (authorizationUrl, answer) => {
      const answered = await fetch(authorizationUrl, {
        redirect: 'manual',
        headers: { [ANSWER_HEADER]: JSON.stringify(answer) },
      });
      const location = answered.headers.get('location');
      if (answered.status !== 302 || location === null) {
        throw new Error(
          `authorize answered ${answered.status}: ${await answered.text()}`,
        );
      }
      return new URL(location);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
