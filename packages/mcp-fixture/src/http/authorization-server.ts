import { createHash, randomBytes } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { waitForFile } from '../fixture-server';

/** Access token lifetime until a test changes it (`/_control/token-lifetime`). */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
/** The account a sign-in uses when the authorization address has no `fixture_account`. */
const DEFAULT_ACCOUNT = 'dev';

/** What the authorization server counted for one account (`/_control/stats`). */
export interface AccountStats {
  /** `POST /token` with `grant_type=refresh_token`, counted on arrival (before a `hold-refresh` latch). */
  refreshes: number;
  /** `POST /token` with `grant_type=authorization_code` whose code belongs to the account. */
  codeExchanges: number;
  /** `GET /authorize` for the account, denied ones included. */
  authorizations: number;
}

/** Which tokens of an account `/_control/revoke` revokes. */
export type RevokeWhich = 'access' | 'refresh' | 'all';

/** Who an access token of this server belongs to (`AuthInfo.extra`), as the MCP paths log it. */
interface TokenOwner {
  account: string;
  tokenId: number;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  account: string;
}

interface AccessToken {
  id: number;
  account: string;
  clientId: string;
  /** Seconds since epoch. */
  expiresAt: number;
  revoked: boolean;
}

interface RefreshToken {
  account: string;
  clientId: string;
  revoked: boolean;
}

/**
 * The fixture's own minimal OAuth authorization server (the SDK has none): metadata, dynamic client
 * registration, authorization without a consent screen, code exchange with PKCE `S256` and refresh with
 * rotation. A replayed (already rotated or revoked) refresh token gets `invalid_grant` and revokes every
 * token of its account. State lives in memory for the life of the process. The issuer is the base address
 * the client used (`http://<Host>`), so `localhost` and `127.0.0.1` clients each see consistent addresses.
 */
export class FixtureAuthorizationServer implements OAuthTokenVerifier {
  private readonly clients = new Map<string, readonly string[]>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Map<string, RefreshToken>();
  private readonly accountStats = new Map<string, AccountStats>();
  private readonly refreshHolds = new Map<string, string>();
  private tokenLifetimeSeconds = DEFAULT_TOKEN_LIFETIME_SECONDS;
  private lastTokenId = 0;

  /** RFC 8414 metadata of this server at `issuer`. */
  metadata(issuer: string): Record<string, unknown> {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** The answer of an authorization server route, or undefined when `path` is not one. */
  async handle(request: Request, path: string, issuer: string): Promise<Response | undefined> {
    switch (path) {
      case '/.well-known/oauth-authorization-server':
        return Response.json(this.metadata(issuer));
      case '/register':
        return request.method === 'POST' ? this.register(request) : methodNotAllowed();
      case '/authorize':
        return this.authorize(new URL(request.url), issuer);
      case '/token':
        return request.method === 'POST' ? this.token(await request.formData()) : methodNotAllowed();
      default:
        return undefined;
    }
  }

  /** `OAuthTokenVerifier` for `requireBearerAuth`: unknown or revoked tokens are `invalid_token`. */
  verifyAccessToken(token: string): Promise<AuthInfo> {
    const access = this.accessTokens.get(token);
    if (access === undefined || access.revoked) {
      return Promise.reject(new OAuthError(OAuthErrorCode.InvalidToken, 'unknown or revoked access token'));
    }
    const owner: TokenOwner = { account: access.account, tokenId: access.id };
    return Promise.resolve({
      token,
      clientId: access.clientId,
      scopes: [],
      expiresAt: access.expiresAt,
      extra: { ...owner },
    });
  }

  setTokenLifetime(seconds: number): void {
    this.tokenLifetimeSeconds = seconds;
  }

  revoke(account: string, which: RevokeWhich): void {
    if (which !== 'refresh') {
      for (const access of this.accessTokens.values()) {
        if (access.account === account) access.revoked = true;
      }
    }
    if (which !== 'access') {
      for (const refresh of this.refreshTokens.values()) {
        if (refresh.account === account) refresh.revoked = true;
      }
    }
  }

  /** Every refresh of `account` waits for the file at `path`; without `path` the hold is lifted. */
  holdRefresh(account: string, path: string | undefined): void {
    if (path === undefined) {
      this.refreshHolds.delete(account);
    } else {
      this.refreshHolds.set(account, path);
    }
  }

  /** Counters of one account, or of every account seen so far. */
  stats(): Record<string, AccountStats>;
  stats(account: string): AccountStats;
  stats(account?: string): AccountStats | Record<string, AccountStats> {
    if (account === undefined) {
      return Object.fromEntries(this.accountStats);
    }
    return { ...this.statsOf(account) };
  }

  private async register(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => undefined);
    const metadata = isRecord(body) ? body : {};
    const redirectUris = metadata.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === 'string')
    ) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must be a non-empty list of addresses');
    }
    const clientId = `fixture-client-${randomBytes(8).toString('hex')}`;
    this.clients.set(clientId, redirectUris);
    return Response.json(
      {
        ...metadata,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      { status: 201 },
    );
  }

  /** No consent screen: a known client and redirect address get a code (or `access_denied`) at once. */
  private authorize(url: URL, issuer: string): Response {
    const params = url.searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const codeChallenge = params.get('code_challenge') ?? '';
    if (!(this.clients.get(clientId)?.includes(redirectUri) ?? false)) {
      return oauthError('invalid_request', 'unknown client_id or unregistered redirect_uri');
    }
    if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !codeChallenge) {
      return oauthError('invalid_request', 'response_type=code with an S256 code_challenge is required');
    }
    const account = params.get('fixture_account') || DEFAULT_ACCOUNT;
    this.statsOf(account).authorizations += 1;
    const target = new URL(redirectUri);
    const state = params.get('state');
    if (state !== null) target.searchParams.set('state', state);
    target.searchParams.set('iss', issuer);
    if (params.get('fixture_deny') === '1') {
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = randomBytes(24).toString('base64url');
      this.codes.set(code, { clientId, redirectUri, codeChallenge, account });
      target.searchParams.set('code', code);
    }
    return new Response(null, { status: 302, headers: { location: target.href } });
  }

  private async token(form: FormData): Promise<Response> {
    switch (form.get('grant_type')) {
      case 'authorization_code':
        return this.exchangeCode(form);
      case 'refresh_token':
        return this.refresh(form);
      default:
        return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
  }

  private exchangeCode(form: FormData): Response {
    const code = String(form.get('code') ?? '');
    const pending = this.codes.get(code);
    this.codes.delete(code);
    if (pending === undefined) {
      return oauthError('invalid_grant', 'unknown or used authorization code');
    }
    this.statsOf(pending.account).codeExchanges += 1;
    const verifier = String(form.get('code_verifier') ?? '');
    if (
      form.get('client_id') !== pending.clientId ||
      form.get('redirect_uri') !== pending.redirectUri ||
      createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge
    ) {
      return oauthError('invalid_grant', 'client_id, redirect_uri or code_verifier does not match the code');
    }
    return Response.json(this.issueTokens(pending.account, pending.clientId));
  }

  private async refresh(form: FormData): Promise<Response> {
    const refreshToken = String(form.get('refresh_token') ?? '');
    const stored = this.refreshTokens.get(refreshToken);
    if (stored === undefined) {
      return oauthError('invalid_grant', 'unknown refresh token');
    }
    this.statsOf(stored.account).refreshes += 1;
    const holdPath = this.refreshHolds.get(stored.account);
    if (holdPath !== undefined && !(await waitForFile(holdPath))) {
      return oauthError('server_error', `refresh hold ${holdPath} was not released`, 500);
    }
    if (stored.revoked || form.get('client_id') !== stored.clientId) {
      // A replayed refresh token: the whole chain of the account is revoked.
      this.revoke(stored.account, 'all');
      return oauthError('invalid_grant', 'refresh token was rotated or revoked');
    }
    stored.revoked = true;
    return Response.json(this.issueTokens(stored.account, stored.clientId));
  }

  private issueTokens(account: string, clientId: string): Record<string, unknown> {
    const accessToken = randomBytes(24).toString('base64url');
    const refreshToken = randomBytes(24).toString('base64url');
    this.lastTokenId += 1;
    this.accessTokens.set(accessToken, {
      id: this.lastTokenId,
      account,
      clientId,
      expiresAt: Math.floor(Date.now() / 1000) + this.tokenLifetimeSeconds,
      revoked: false,
    });
    this.refreshTokens.set(refreshToken, { account, clientId, revoked: false });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.tokenLifetimeSeconds,
      refresh_token: refreshToken,
    };
  }

  private statsOf(account: string): AccountStats {
    let stats = this.accountStats.get(account);
    if (stats === undefined) {
      stats = { refreshes: 0, codeExchanges: 0, authorizations: 0 };
      this.accountStats.set(account, stats);
    }
    return stats;
  }
}

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
