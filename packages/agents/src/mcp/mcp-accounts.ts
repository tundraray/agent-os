import type { LogFields, Logger } from '@agent-os/common';
import { McpServerModeSchema, type McpConnection } from '@agent-os/contracts';
import {
  AgentMcpAccountsRepository,
  AgentMcpServersRepository,
  type McpAccountRow,
  type McpServerRow,
  type McpTokens,
} from '@agent-os/db';
import {
  IssuerMismatchError,
  OAuthError,
  OAuthErrorCode,
  UnauthorizedError,
  exchangeAuthorization,
  isSpecType,
  refreshAuthorization,
  startAuthorization,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { Inject, Injectable } from '@nestjs/common';

import type { AccessGate, ToolAccess } from '../access-gate';
import { ACCESS_GATE, AGENTS_CONFIG, AGENTS_LOGGER } from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { type ConnectRequest, ConnectRequests, type ConnectTarget } from './connect-requests';
import { type McpAuth, deadlineFetch } from './mcp-client';
import { type McpFailure, failureName, transportFailureReason } from './mcp-failure';
import { storedMcpTools } from './mcp-tool';
import { checkServerUrl } from './mcp-url';

/** A token closer than this to its end is refreshed before the call (Runtime settings). */
const REFRESH_BEFORE_EXPIRY_MS = 60 * 1000;

/** A server the employee may use and the names of its tools he has the right to (deep-agents KD-3). */
export interface UsableMcpServer {
  readonly server: string;
  readonly tools: readonly string[];
}

export interface McpConnectBegin {
  readonly ownerId: string;
  readonly server: string;
  readonly target: ConnectTarget;
  /** The server's own return address, `<public address>/api/mcp/oauth/callback/<server>`, built by the controller (ADR-0014). */
  readonly redirectUrl: string;
}

/** Where the browser goes: to the authorization server, or back with `connect_failed`. */
export type McpConnectStart =
  { readonly kind: 'redirect'; readonly authorizationUrl: URL } | { readonly kind: 'refused' };

/** The return from the authorization server, as the callback received it, with the session's employee. */
export interface McpConnectReturn {
  readonly ownerId: string;
  /** The session's admin right at the moment of the return (DC-13). */
  readonly isAdmin: boolean;
  /** The server of the return address the callback arrived at (its path). */
  readonly server: string;
  readonly state: string;
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
}

export type McpConnectOutcome = 'connected' | 'connect_failed' | 'access_denied';

/** How the return ended; no token leaves the package. `request` is absent when no request matched `state`. */
export interface McpConnectFinish {
  readonly outcome: McpConnectOutcome;
  readonly request: { readonly server: string; readonly target: ConnectTarget } | null;
}

/** The credentials of one call, or why the call gets none and is not sent (KD-5, DC-3). */
export type McpCredentials =
  | {
      readonly kind: 'ready';
      /** The server address, read with the credentials from the same row. */
      readonly url: string;
      readonly auth: McpAuth;
      /**
       * Called when the call ended `auth_required`: the server refused even the refreshed token, so the
       * account is lost and its row deleted (KD-5). A no-op for a shared token.
       */
      rejected(): Promise<void>;
    }
  | McpFailure
  /** The server is not registered — or, for an agent's call, is switched off: nothing is sent. */
  | { readonly kind: 'server_gone' };

/** What an `oauth` server row gives the OAuth functions of the SDK. */
interface OAuthServer {
  readonly url: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly client: OAuthClientInformationMixed;
}

/** The SDK's metadata as the registry stored it (T2.3); anything else in the row is a defect. */
function oauthServerOf(row: McpServerRow): OAuthServer {
  const metadata: unknown = row.oauthServer;
  if (
    row.oauthClientId === null ||
    !(isSpecType.OAuthMetadata(metadata) || isSpecType.OpenIdProviderDiscoveryMetadata(metadata))
  ) {
    throw new Error(`MCP server ${row.name} has no usable OAuth client registration`);
  }
  const client =
    row.oauthClientSecret === null
      ? { client_id: row.oauthClientId }
      : { client_id: row.oauthClientId, client_secret: row.oauthClientSecret };
  return { url: row.url, metadata, client };
}

function isOAuthServer(row: McpServerRow | undefined): row is McpServerRow {
  return row !== undefined && row.mode === McpServerModeSchema.enum.oauth;
}

/** An enabled server the employee may use: the gate allows him at least one tool of its list. */
function usableServer(row: McpServerRow, access: ToolAccess): boolean {
  if (!row.enabled || access.kind === 'owner_disabled') return false;
  return (storedMcpTools(row.tools) ?? []).some((tool) => access.allows(row.name, tool.tool));
}

/** Tokens as stored: `expires_in` seconds from now becomes the end of the access. */
function tokensOf(tokens: OAuthTokens, now: Date): McpTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expires_in === undefined ? null : new Date(now.getTime() + tokens.expires_in * 1000),
  };
}

/** Seconds of access left, for the log; the token itself never is. */
function expiresIn(expiresAt: Date | null): number | null {
  return expiresAt === null ? null : Math.round((expiresAt.getTime() - Date.now()) / 1000);
}

function expiresSoon(account: McpAccountRow): boolean {
  return account.expiresAt !== null && account.expiresAt.getTime() - Date.now() < REFRESH_BEFORE_EXPIRY_MS;
}

function isInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant;
}

/** A failed code exchange that is the authorization server's or the network's, not a defect. */
function isExchangeFailure(error: unknown): boolean {
  return (
    error instanceof IssuerMismatchError || error instanceof OAuthError || transportFailureReason(error) !== undefined
  );
}

/**
 * Accounts of employees on `oauth` servers (KD-4, KD-5, KD-6): the connection by OAuth with PKCE, the token
 * read from the database at the moment of the call and refreshed before it, and the account deleted when it
 * can no longer be refreshed. Tokens live in `agent_mcp_accounts` only; in process memory are the connection
 * requests and the refreshes in flight (ADR-0001). The authorization server is called outside any
 * transaction (repository-over-transaction.md). No operation returns a token, and none is logged.
 */
@Injectable()
export class McpAccounts {
  /** One refresh at a time per pair «server — owner» (DC-4, Invariant 4): the others wait for it. */
  private readonly refreshes = new Map<string, Promise<string | undefined>>();
  private readonly logger: Logger;
  /** `MCP_CALL_TIMEOUT_MS`: bounds a code exchange and a token refresh. */
  private readonly callTimeoutMs: number;
  /** Development only: an `http` authorization address passes the address rule. */
  private readonly allowHttp: boolean;

  constructor(
    @Inject(AgentMcpServersRepository) private readonly mcpServerRows: AgentMcpServersRepository,
    @Inject(AgentMcpAccountsRepository) private readonly mcpAccountRows: AgentMcpAccountsRepository,
    @Inject(ConnectRequests) private readonly requests: ConnectRequests,
    /** The one access check (Contract «Для `access`»): the same as in the tool set and the call check. */
    @Inject(ACCESS_GATE) private readonly access: Pick<AccessGate, 'tools'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
    @Inject(AGENTS_CONFIG) config: Pick<AgentsConfig, 'mcpCallTimeoutMs' | 'allowHttpUrls'>,
  ) {
    this.logger = logger.child({ service: 'agents.mcp' });
    this.callTimeoutMs = config.mcpCallTimeoutMs;
    this.allowHttp = config.allowHttpUrls;
  }

  /**
   * Enabled `oauth` servers with at least one tool the gate allows the employee, by name, with his account
   * status (AC-14.1, AC-14.6); none for a disabled employee.
   */
  async connections(ownerId: string): Promise<McpConnection[]> {
    const servers = (await this.usableServers(ownerId)).rows.filter(isOAuthServer);
    if (servers.length === 0) return [];
    const connected = new Set((await this.mcpAccountRows.listOwned(ownerId)).map((account) => account.server));
    return servers.map((row) => ({
      server: row.name,
      url: row.url,
      status: connected.has(row.name) ? 'connected' : 'needs_auth',
    }));
  }

  /**
   * Opens a connection request and gives the authorization address (Flow 2, PKCE `S256`, `resource` — the
   * server's address). An employee connects only to an enabled server he is allowed; the admin to his `oauth`
   * server in any status. Otherwise `refused`, and the authorization server gets nothing.
   */
  async begin(input: McpConnectBegin): Promise<McpConnectStart> {
    const fields = { ownerId: input.ownerId, server: input.server, target: input.target };
    const row = await this.mcpServerRows.find(input.server);
    if (!isOAuthServer(row) || !(await this.mayBegin(input, row))) {
      this.logger.warn('mcp connect refused', { ...fields, outcome: 'refused' });
      return { kind: 'refused' };
    }
    const { url, metadata, client } = oauthServerOf(row);
    const { authorizationUrl, codeVerifier } = await startAuthorization(metadata.issuer, {
      metadata,
      clientInformation: client,
      redirectUrl: input.redirectUrl,
      resource: url,
    });
    if (checkServerUrl(authorizationUrl, { allowHttp: this.allowHttp }) !== 'ok') {
      this.logger.warn('mcp connect refused', { ...fields, outcome: 'refused', reason: 'insecure_url' });
      return { kind: 'refused' };
    }
    const { id, state } = this.requests.open({
      ownerId: input.ownerId,
      server: input.server,
      target: input.target,
      codeVerifier,
      redirectUrl: input.redirectUrl,
      issuer: metadata.issuer,
    });
    authorizationUrl.searchParams.set('state', state);
    this.logger.info('mcp connect begun', { ...fields, requestId: id, outcome: 'redirect' });
    return { kind: 'redirect', authorizationUrl };
  }

  /**
   * The return from the authorization server (DC-5, DC-13): the request is taken once and only by its own
   * employee; a return at another server's address than the request's, an `error` of the authorization
   * server, a missing or foreign `iss` (checked by the SDK before the code is redeemed), or an admin target
   * without the admin right end it without an exchange. Otherwise
   * the code is exchanged with the PKCE verifier and the account is stored.
   */
  async finish(input: McpConnectReturn): Promise<McpConnectFinish> {
    const request = this.requests.take(input.state, input.ownerId, new Date());
    if (request === undefined) {
      this.logger.warn('mcp connect returned', {
        ownerId: input.ownerId,
        outcome: 'connect_failed',
        reason: 'no_request',
      });
      return { outcome: 'connect_failed', request: null };
    }
    const fields: LogFields = {
      ownerId: request.ownerId,
      server: request.server,
      target: request.target,
      requestId: request.id,
    };
    const ended = (outcome: McpConnectOutcome, reason?: string, details: LogFields = {}): McpConnectFinish => {
      if (outcome === 'connected') this.logger.info('mcp connect returned', { ...fields, outcome });
      else this.logger.warn('mcp connect returned', { ...fields, ...details, outcome, reason });
      return { outcome, request: { server: request.server, target: request.target } };
    };
    // Each server has its own return address: a code that came back at another server's is not this request's.
    if (input.server !== request.server) {
      return ended('connect_failed', 'server_mismatch', { returnedAt: input.server });
    }
    if (input.error !== undefined) return ended('connect_failed', `authorization_${input.error}`);
    if (request.target === 'admin' && !input.isAdmin) return ended('access_denied', 'not_admin');
    if (input.code === undefined) return ended('connect_failed', 'no_code');
    const row = await this.mcpServerRows.find(request.server);
    if (!isOAuthServer(row)) return ended('connect_failed', 'server_gone');
    const server = oauthServerOf(row);
    if (server.metadata.issuer !== request.issuer) return ended('connect_failed', 'issuer_changed');
    const exchanged = await this.exchange(server, request, { code: input.code, iss: input.iss });
    if (exchanged === undefined) return ended('connect_failed', 'exchange_failed');
    await this.mcpAccountRows.upsert({ ownerId: request.ownerId, server: request.server, ...exchanged });
    return ended('connected');
  }

  /**
   * The credentials of a call, read from the database just before it (KD-5, Invariant 3): a shared token from
   * the server row, or the owner's account, refreshed first when less than 60 seconds of access are left.
   * Without an account, or when the refresh lost it, the call gets `auth_required` and is not sent (DC-3); an
   * unreachable authorization server gives `failure` and the account stays (Flow 3). A server removed
   * meanwhile is `server_gone`; so is a switched-off one for an agent's `call`, while the `admin` reads the
   * tools of a server in any status.
   */
  async credentialsFor(server: string, ownerId: string, use: 'call' | 'admin'): Promise<McpCredentials> {
    const row = await this.mcpServerRows.find(server);
    if (row === undefined || (use === 'call' && !row.enabled)) {
      this.logger.warn('mcp token not issued', { server, ownerId, outcome: 'server_gone', use });
      return { kind: 'server_gone' };
    }
    if (row.mode === McpServerModeSchema.enum.shared) {
      const token = row.sharedToken;
      if (token === null) throw new Error(`MCP server ${server} has no shared token`);
      return {
        kind: 'ready',
        url: row.url,
        auth: { mode: 'shared', token: () => Promise.resolve(token) },
        rejected: async () => {},
      };
    }
    const account = await this.mcpAccountRows.find(server, ownerId);
    if (account === undefined) {
      this.logger.info('mcp token issued', { server, ownerId, outcome: 'auth_required', reason: 'no_account' });
      return { kind: 'auth_required' };
    }
    let accessToken = account.accessToken;
    if (expiresSoon(account)) {
      try {
        const refreshed = await this.refresh(server, ownerId, accessToken);
        if (refreshed === undefined) return { kind: 'auth_required' };
        accessToken = refreshed;
      } catch (error) {
        const reason = transportFailureReason(error);
        if (reason === undefined) throw error;
        return { kind: 'failure', reason };
      }
    } else {
      this.logger.info('mcp token issued', {
        server,
        ownerId,
        outcome: 'issued',
        expiresIn: expiresIn(account.expiresAt),
      });
    }
    return this.oauthCredentials(row.url, { server, ownerId }, accessToken);
  }

  /** Removes the employee's account on the server; no account is a success too (AC-14.4). */
  async disconnect(ownerId: string, server: string): Promise<void> {
    const removed = await this.mcpAccountRows.delete(server, ownerId);
    this.logger.info('mcp account disconnected', { ownerId, server, outcome: removed ? 'removed' : 'none' });
  }

  /** Names of enabled servers of any mode with at least one tool the gate allows the employee, by name (KD-4). */
  async usable(ownerId: string): Promise<string[]> {
    return (await this.usableServers(ownerId)).rows.map((row) => row.name);
  }

  /**
   * The servers of `usable` with the names of their tools the gate allows the employee, in the server's
   * list order (deep-agents KD-3, DC-7); none for a disabled employee.
   */
  async usableTools(ownerId: string): Promise<UsableMcpServer[]> {
    const { rows, access } = await this.usableServers(ownerId);
    if (access.kind === 'owner_disabled') return [];
    return rows.map((row) => ({
      server: row.name,
      tools: (storedMcpTools(row.tools) ?? [])
        .map((tool) => tool.tool)
        .filter((tool) => access.allows(row.name, tool)),
    }));
  }

  /** Enabled servers of any mode the employee may use, by name, with the gate's answer; none for a disabled employee. */
  private async usableServers(ownerId: string): Promise<{ rows: McpServerRow[]; access: ToolAccess }> {
    const access = await this.access.tools(ownerId);
    if (access.kind === 'owner_disabled') return { rows: [], access };
    const rows = (await this.mcpServerRows.list()).filter((row) => usableServer(row, access));
    return { rows, access };
  }

  /** The admin connects his `oauth` server in any status; an employee only one he may use (`connections`' rule). */
  private async mayBegin(input: McpConnectBegin, row: McpServerRow): Promise<boolean> {
    if (input.target === 'admin') return true;
    return usableServer(row, await this.access.tools(input.ownerId));
  }

  /** Tokens for the code, or `undefined` when the authorization server or the network refused the exchange. */
  private async exchange(
    server: OAuthServer,
    request: ConnectRequest,
    returned: { readonly code: string; readonly iss: string | undefined },
  ): Promise<McpTokens | undefined> {
    try {
      const tokens = await exchangeAuthorization(server.metadata.issuer, {
        metadata: server.metadata,
        clientInformation: server.client,
        authorizationCode: returned.code,
        ...(returned.iss === undefined ? {} : { iss: returned.iss }),
        codeVerifier: request.codeVerifier,
        redirectUri: request.redirectUrl,
        resource: server.url,
        fetchFn: deadlineFetch(this.callTimeoutMs),
      });
      return tokensOf(tokens, new Date());
    } catch (error) {
      if (!isExchangeFailure(error)) throw error;
      this.logger.warn('mcp code exchange failed', {
        ownerId: request.ownerId,
        server: request.server,
        requestId: request.id,
        error: failureName(error),
      });
      return undefined;
    }
  }

  /**
   * An `oauth` call's auth: the token sent is the one read for this call; a 401 refreshes it once through
   * the same one-at-a-time refresh. A lost account makes `onUnauthorized` throw `UnauthorizedError`, which the
   * client maps to `auth_required`; an unreachable authorization server rethrows its transport error.
   */
  private oauthCredentials(
    url: string,
    { server, ownerId }: { readonly server: string; readonly ownerId: string },
    accessToken: string,
  ): McpCredentials {
    let current = accessToken;
    return {
      kind: 'ready',
      url,
      auth: {
        mode: 'oauth',
        token: () => Promise.resolve(current),
        onUnauthorized: async () => {
          const refreshed = await this.refresh(server, ownerId, current);
          if (refreshed === undefined) throw new UnauthorizedError(`MCP account on ${server} is lost`);
          current = refreshed;
        },
      },
      rejected: async () => {
        const account = await this.mcpAccountRows.find(server, ownerId);
        if (account?.accessToken !== current) return;
        await this.mcpAccountRows.delete(server, ownerId);
        this.logger.warn('mcp account lost', { server, ownerId, reason: 'unauthorized_after_refresh' });
      },
    };
  }

  /**
   * The new access token of the pair, or `undefined` when the account is lost. A refresh already running for
   * the pair is joined, not repeated: a rotating authorization server would revoke the whole chain for a
   * reused refresh token (DC-4).
   */
  private refresh(server: string, ownerId: string, staleToken: string): Promise<string | undefined> {
    const key = JSON.stringify([server, ownerId]);
    const running = this.refreshes.get(key);
    if (running !== undefined) {
      this.logger.info('mcp token refresh joined', { server, ownerId });
      return running;
    }
    const refresh = this.runRefresh(server, ownerId, staleToken).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, refresh);
    return refresh;
  }

  /**
   * Refreshes only when the stored token is still the stale one (a refresh that finished meanwhile is used
   * as is). `invalid_grant`, no refresh token or a vanished account lose the account (DC-3); a transport
   * failure propagates and the account stays. The new tokens are stored before the promise resolves.
   */
  private async runRefresh(server: string, ownerId: string, staleToken: string): Promise<string | undefined> {
    const { logger, mcpServerRows, mcpAccountRows } = this;
    const startedAt = performance.now();
    const fields = { server, ownerId };
    const durationMs = () => Math.round(performance.now() - startedAt);
    const lost = async (reason: string): Promise<undefined> => {
      await mcpAccountRows.delete(server, ownerId);
      logger.warn('mcp token refresh', { ...fields, outcome: 'account_lost', reason, durationMs: durationMs() });
      return undefined;
    };
    const account = await mcpAccountRows.find(server, ownerId);
    if (account === undefined) return lost('no_account');
    if (account.accessToken !== staleToken) return account.accessToken;
    const row = await mcpServerRows.find(server);
    if (account.refreshToken === null || !isOAuthServer(row)) return lost('no_refresh_token');
    const { url, metadata, client } = oauthServerOf(row);
    let tokens: McpTokens;
    try {
      const refreshed = await refreshAuthorization(metadata.issuer, {
        metadata,
        clientInformation: client,
        refreshToken: account.refreshToken,
        resource: url,
        fetchFn: deadlineFetch(this.callTimeoutMs),
      });
      tokens = tokensOf(refreshed, new Date());
    } catch (error) {
      if (isInvalidGrant(error)) return lost('invalid_grant');
      logger.warn('mcp token refresh', {
        ...fields,
        outcome: 'failed',
        reason: transportFailureReason(error),
        error: failureName(error),
        durationMs: durationMs(),
      });
      throw error;
    }
    if (!(await mcpAccountRows.updateTokens(server, ownerId, tokens))) return lost('disconnected_meanwhile');
    logger.info('mcp token refresh', {
      ...fields,
      outcome: 'refreshed',
      expiresIn: expiresIn(tokens.expiresAt),
      durationMs: durationMs(),
    });
    return tokens.accessToken;
  }
}
