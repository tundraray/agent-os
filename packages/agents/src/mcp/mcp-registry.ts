import type { LogFields, Logger } from '@agent-os/common';
import {
  McpErrorCode,
  McpServerModeSchema,
  type McpCheckFailureReason,
  type McpServerMode,
  type McpServerStatus,
  type McpServerSummary,
  type McpServerView,
  type McpToolView,
  type RegisterMcpServerBody,
  type UpdateMcpServerBody,
} from '@agent-os/contracts';
import {
  AgentMcpServersRepository,
  DATABASE,
  type Database,
  type McpServerPatch,
  type McpServerRow,
  type NewMcpServerRow,
} from '@agent-os/db';
import {
  LATEST_PROTOCOL_VERSION,
  RegistrationRejectedError,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  registerClient,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthServerInfo,
} from '@modelcontextprotocol/client';
import { Inject, Injectable } from '@nestjs/common';

import { AGENTS_CONFIG, AGENTS_LOGGER } from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { CLIENT_INFO, type McpAuth, McpClient, deadlineFetch } from './mcp-client';
import { McpError } from './mcp-errors';
import { type McpFailureReason, failureName, mcpFailureReason, transportFailureReason } from './mcp-failure';
import { type McpTool, storedMcpTools, toMcpTool } from './mcp-tool';
import { checkServerUrl } from './mcp-url';
import { shapeBlockOf } from './tool-shape';

/** Stands in for the shared token in «было/стало»: `AuditLog` writes `secret_changed` for its field name. */
const SECRET_MARK = 'changed';

/** The server as an audit entry keeps it: no secret value, only the mark of a token set or replaced. */
export interface McpServerAuditState {
  readonly name: string;
  readonly url: string;
  readonly mode: string;
  readonly enabled: boolean;
  /** Names of the listed tools; `null` while the server has no list. */
  readonly tools: readonly string[] | null;
  readonly sharedToken?: typeof SECRET_MARK;
}

/** A registry write: the server as the admin now sees it, and «было/стало» for `admin_change`. */
export interface McpServerWrite {
  readonly view: McpServerView;
  readonly before: McpServerAuditState | null;
  readonly after: McpServerAuditState;
}

/** A tool list read anew: the write and the names of new and removed tools. */
export interface McpToolsRefresh extends McpServerWrite {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface McpServerRemoval {
  readonly before: McpServerAuditState;
  readonly after: null;
}

/** Registration as the admin sent it, with the server's own OAuth return address the controller built. */
export type McpServerRegistration = RegisterMcpServerBody & { readonly redirectUrl: string };

/**
 * After the admin connected his account: the list was read and stored, the server still waits for it
 * (`tools_failed`), or the server was removed meanwhile (`connect_failed`).
 */
export type McpAdminAccountCompletion =
  | { readonly outcome: 'connected'; readonly change: McpToolsRefresh }
  | { readonly outcome: 'tools_failed' | 'connect_failed' };

const CHECK_REASON_OF_FAILURE: Record<McpFailureReason, McpCheckFailureReason> = {
  connection_lost: 'unreachable',
  timeout: 'timeout',
  protocol_error: 'not_mcp',
  client_error: 'not_mcp',
  unauthorized: 'unauthorized',
};

/** The first request of an MCP session, sent without a token to learn whether and how the server asks for one. */
const PROBE_REQUEST = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
};

/** PKCE method the platform uses (KD-4); a server that does not announce it cannot be connected. */
const PKCE_METHOD = 'S256';

/** A credential failure before a listing (an admin token refresh that got no answer) as the check's refusal. */
export function credentialsCheckFailed(reason: McpFailureReason): McpError {
  return checkFailed(CHECK_REASON_OF_FAILURE[reason]);
}

function checkFailed(reason: McpCheckFailureReason): McpError {
  return new McpError(McpErrorCode.MCP_SERVER_CHECK_FAILED, `MCP server check failed: ${reason}`, reason);
}

export function notFound(name: string): McpError {
  return new McpError(McpErrorCode.MCP_SERVER_NOT_FOUND, `MCP server ${name} is not registered`);
}

function nameTaken(name: string): McpError {
  return new McpError(McpErrorCode.MCP_SERVER_NAME_TAKEN, `MCP server name ${name} is taken`);
}

/** A failed tool listing as the reason of the check; an error outside the client's classes is a defect. */
function listingFailureReason(error: unknown, mode: McpServerMode): McpCheckFailureReason {
  const failure = mcpFailureReason(error, mode);
  return failure.kind === 'auth_required' ? 'unauthorized' : CHECK_REASON_OF_FAILURE[failure.reason];
}

/** A failed OAuth discovery or registration: no connection, no answer in time, or the step's own reason. */
function oauthFailureReason(error: unknown, otherwise: McpCheckFailureReason): McpCheckFailureReason {
  if (error instanceof RegistrationRejectedError) return 'registration_rejected';
  const reason = transportFailureReason(error);
  return reason === 'connection_lost' || reason === 'timeout' ? CHECK_REASON_OF_FAILURE[reason] : otherwise;
}

function bearer(mode: McpServerMode, token: string): McpAuth {
  return { mode, token: () => Promise.resolve(token) };
}

function statusOf(row: McpServerRow, tools: readonly McpTool[] | null): McpServerStatus {
  if (row.enabled) return 'enabled';
  return tools === null ? 'awaiting_admin_account' : 'disabled';
}

function summaryOf(row: McpServerRow, tools = storedMcpTools(row.tools)): McpServerSummary {
  return {
    name: row.name,
    url: row.url,
    mode: McpServerModeSchema.parse(row.mode),
    status: statusOf(row, tools),
    toolCount: tools?.length ?? 0,
  };
}

function toolViewOf(tool: McpTool): McpToolView {
  return {
    name: tool.tool,
    title: tool.display.toolTitle ?? null,
    description: tool.description,
    readOnly: tool.readOnly,
  };
}

/** The server for the admin: whether a shared token is set, never its value (AC-13.5). */
function viewOf(row: McpServerRow): McpServerView {
  const tools = storedMcpTools(row.tools);
  return {
    ...summaryOf(row, tools),
    sharedTokenSet: row.sharedToken !== null,
    tools: (tools ?? []).map(toolViewOf),
  };
}

function auditStateOf(row: McpServerRow, tokenChanged: boolean): McpServerAuditState {
  return {
    name: row.name,
    url: row.url,
    mode: row.mode,
    enabled: row.enabled,
    tools: storedMcpTools(row.tools)?.map((tool) => tool.tool) ?? null,
    ...(tokenChanged ? { sharedToken: SECRET_MARK } : {}),
  };
}

function difference(from: readonly string[] | null, without: readonly string[] | null): string[] {
  const excluded = new Set(without ?? []);
  return (from ?? []).filter((name) => !excluded.has(name));
}

/**
 * The admin's registry (KD-1, KD-2): a server is checked over the network before anything is stored, and the
 * check, OAuth discovery and client registration run before the write and outside any transaction
 * (repository-over-transaction.md). Writes return «было/стало» without secret values for the audit (Invariant 6).
 */
@Injectable()
export class McpRegistry {
  private readonly logger: Logger;
  /** `MCP_CALL_TIMEOUT_MS`: bounds each check, the OAuth discovery and registration included. */
  private readonly callTimeoutMs: number;
  /** Development only: `http` addresses pass the address rule. */
  private readonly allowHttp: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AgentMcpServersRepository) private readonly mcpServerRows: AgentMcpServersRepository,
    @Inject(McpClient) private readonly client: McpClient,
    @Inject(AGENTS_LOGGER) logger: Logger,
    @Inject(AGENTS_CONFIG) config: Pick<AgentsConfig, 'mcpCallTimeoutMs' | 'allowHttpUrls'>,
  ) {
    this.logger = logger.child({ service: 'agents.mcp' });
    this.callTimeoutMs = config.mcpCallTimeoutMs;
    this.allowHttp = config.allowHttpUrls;
  }

  async list(): Promise<McpServerSummary[]> {
    const rows = await this.mcpServerRows.list(this.database);
    return rows.map((row) => summaryOf(row));
  }

  async get(name: string): Promise<McpServerView> {
    return viewOf(await this.rowOf(name));
  }

  /**
   * Registers a checked server (DC-6): `shared` — enabled with the tools its token lists; `oauth` — the
   * platform's OAuth client registered at the server's authorization server, waiting for the admin's account
   * (DC-7). A failed check stores nothing.
   */
  register(input: McpServerRegistration): Promise<McpServerWrite> {
    return this.logged('mcp server registration', { server: input.name, mode: input.mode }, async () => {
      const { name, url, mode } = input;
      if ((await this.mcpServerRows.find(this.database, name)) !== undefined) throw nameTaken(name);
      this.requireSecureUrl(url);
      const row: NewMcpServerRow =
        input.mode === 'shared'
          ? {
              name,
              url,
              mode,
              enabled: true,
              tools: await this.listChecked(name, url, bearer('shared', input.sharedToken)),
              sharedToken: input.sharedToken,
            }
          : { name, url, mode, ...(await this.registerOAuthClient(url, input.redirectUrl)) };
      const inserted = await this.mcpServerRows.insert(this.database, row);
      if (inserted === undefined) throw nameTaken(name);
      return { view: viewOf(inserted), before: null, after: auditStateOf(inserted, mode === 'shared') };
    });
  }

  /** Switches the server on or off and replaces its shared token; a new token is checked first (DC-6, DC-7). */
  update(name: string, patch: UpdateMcpServerBody): Promise<McpServerWrite> {
    const fields = { server: name, enabled: patch.enabled, sharedTokenReplaced: patch.sharedToken !== undefined };
    return this.logged('mcp server update', fields, async () => {
      const row = await this.rowOf(name);
      if (patch.enabled === true && row.tools === null) {
        throw new McpError(McpErrorCode.MCP_SERVER_INCOMPLETE, `MCP server ${name} has no tool list yet`);
      }
      if (patch.sharedToken !== undefined) {
        if (row.mode !== McpServerModeSchema.enum.shared) {
          throw new McpError('VALIDATION_FAILED', `MCP server ${name} is in mode ${row.mode} and has no shared token`);
        }
        await this.listChecked(name, row.url, bearer('shared', patch.sharedToken));
      }
      return this.write(name, patch, patch.sharedToken !== undefined);
    });
  }

  /**
   * Reads the tool list anew with the given credentials (the shared token or the current admin's account,
   * chosen by the caller) and replaces it whole; a failed read keeps the old list. A server that waited for
   * its list is switched on with it (waiting → enabled).
   */
  refreshTools(name: string, auth: McpAuth): Promise<McpToolsRefresh> {
    return this.logged('mcp server tools refresh', { server: name, mode: auth.mode }, async () => {
      const row = await this.rowOf(name);
      const tools = await this.listChecked(name, row.url, auth);
      const write = await this.write(name, { tools, ...(row.tools === null ? { enabled: true } : {}) }, false);
      return {
        ...write,
        added: difference(write.after.tools, write.before?.tools ?? null),
        removed: difference(write.before?.tools ?? null, write.after.tools),
      };
    });
  }

  /**
   * After the admin connected his account to an `oauth` server: the list is read with his token, stored, and a
   * waiting server is switched on (Flow 1). A failed read leaves the server waiting: `tools_failed`; a server
   * removed meanwhile is `connect_failed`.
   */
  async completeAdminAccount(name: string, accessToken: string): Promise<McpAdminAccountCompletion> {
    try {
      return { outcome: 'connected', change: await this.refreshTools(name, bearer('oauth', accessToken)) };
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      if (error.code === McpErrorCode.MCP_SERVER_CHECK_FAILED) return { outcome: 'tools_failed' };
      if (error.code === McpErrorCode.MCP_SERVER_NOT_FOUND) return { outcome: 'connect_failed' };
      throw error;
    }
  }

  /** Removes the server; the cascade removes every account on it (AC-13.6). */
  remove(name: string): Promise<McpServerRemoval> {
    return this.logged('mcp server removal', { server: name }, async () => {
      const row = await this.mcpServerRows.delete(this.database, name);
      if (row === undefined) throw notFound(name);
      return { before: auditStateOf(row, false), after: null };
    });
  }

  private async rowOf(name: string): Promise<McpServerRow> {
    const row = await this.mcpServerRows.find(this.database, name);
    if (row === undefined) throw notFound(name);
    return row;
  }

  private async write(name: string, patch: McpServerPatch, tokenChanged: boolean): Promise<McpServerWrite> {
    const change = await this.database.transaction((tx) =>
      this.mcpServerRows.update(tx, name, patch),
    );
    if (change === undefined) throw notFound(name);
    return {
      view: viewOf(change.after),
      before: auditStateOf(change.before, false),
      after: auditStateOf(change.after, tokenChanged),
    };
  }

  private requireSecureUrl(url: string | URL): void {
    if (checkServerUrl(url, { allowHttp: this.allowHttp }) !== 'ok') throw checkFailed('insecure_url');
  }

  /** The server's tools by name as `McpTool`s, or the reason the listing failed. */
  private async listChecked(name: string, url: string, auth: McpAuth): Promise<McpTool[]> {
    const { client, callTimeoutMs } = this;
    try {
      const listed = await client.listTools({ url, auth, timeoutMs: callTimeoutMs });
      const tools = listed.map((tool) => toMcpTool(name, tool)).sort((a, b) => a.tool.localeCompare(b.tool));
      this.logShapes(name, tools);
      return tools;
    } catch (error) {
      const reason = listingFailureReason(error, auth.mode);
      this.logger.warn('mcp server did not list its tools', {
        server: name,
        mode: auth.mode,
        reason,
        error: failureName(error),
      });
      throw checkFailed(reason);
    }
  }

  /**
   * One record per listing about the declared result shapes (tool-output-shapes design-core.md, «Логирование»),
   * measured by the same function the agent's step uses; the shape text and the schema stay out of the log.
   */
  private logShapes(server: string, tools: readonly McpTool[]): void {
    const shapes = tools.flatMap(({ tool, outputSchema }) =>
      outputSchema === undefined ? [] : [{ tool, ...shapeBlockOf(outputSchema) }],
    );
    this.logger.info('mcp server tools listed', {
      server,
      tools: tools.length,
      withShape: shapes.length,
      longestShapeBlock: Math.max(0, ...shapes.map(({ block }) => block.length)),
      truncatedShapes: shapes.filter(({ truncated }) => truncated).map(({ tool }) => tool),
    });
  }

  /**
   * KD-4: the server answers a request without a token with 401; its protected-resource metadata names the
   * authorization server, whose metadata has a registration endpoint and PKCE `S256`; the platform registers
   * as a public client with one return address, the server's own. OAuth support is decided by the protected-resource metadata,
   * never by a fallback to the server's origin.
   */
  private async registerOAuthClient(
    url: string,
    redirectUrl: string,
  ): Promise<Pick<NewMcpServerRow, 'oauthServer' | 'oauthClientId' | 'oauthClientSecret'>> {
    const fetchFn = deadlineFetch(this.callTimeoutMs);
    const resourceMetadataUrl = await this.challengeOf(url, fetchFn);
    if (resourceMetadataUrl !== undefined) this.requireSecureUrl(resourceMetadataUrl);
    const metadata = await this.discoverRegistrable(url, resourceMetadataUrl, fetchFn);
    try {
      const client = await registerClient(metadata.issuer, {
        metadata,
        clientMetadata: {
          client_name: CLIENT_INFO.name,
          redirect_uris: [redirectUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        fetchFn,
      });
      return {
        oauthServer: metadata,
        oauthClientId: client.client_id,
        oauthClientSecret: client.client_secret ?? null,
      };
    } catch (error) {
      throw this.oauthCheckFailed(url, error, 'registration_rejected');
    }
  }

  /** The `resource_metadata` address of the server's 401 to a request without a token. */
  private async challengeOf(url: string, fetchFn: FetchLike): Promise<URL | undefined> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(PROBE_REQUEST),
      });
    } catch (error) {
      throw checkFailed(listingFailureReason(error, 'oauth'));
    }
    await response.body?.cancel();
    if (response.status === 401) return extractWWWAuthenticateParams(response).resourceMetadataUrl;
    this.logger.warn('mcp server did not ask for a token', { url, status: response.status });
    throw checkFailed(response.ok ? 'oauth_not_supported' : 'not_mcp');
  }

  /** Authorization server metadata that allows registration and PKCE, its addresses passing the address rule. */
  private async discoverRegistrable(
    url: string,
    resourceMetadataUrl: URL | undefined,
    fetchFn: FetchLike,
  ): Promise<AuthorizationServerMetadata> {
    let info: OAuthServerInfo;
    try {
      info = await discoverOAuthServerInfo(url, { resourceMetadataUrl, fetchFn });
    } catch (error) {
      throw this.oauthCheckFailed(url, error, 'oauth_not_supported');
    }
    const metadata = info.authorizationServerMetadata;
    const announced = (info.resourceMetadata?.authorization_servers?.length ?? 0) > 0;
    if (
      !announced ||
      metadata?.registration_endpoint === undefined ||
      !(metadata.code_challenge_methods_supported ?? []).includes(PKCE_METHOD)
    ) {
      this.logger.warn('mcp server has no usable OAuth metadata', {
        url,
        resourceMetadata: info.resourceMetadata !== undefined,
        registrationEndpoint: metadata?.registration_endpoint !== undefined,
      });
      throw checkFailed('oauth_not_supported');
    }
    for (const address of [
      info.authorizationServerUrl,
      metadata.issuer,
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
    ]) {
      this.requireSecureUrl(address);
    }
    return metadata;
  }

  /** Logs the error class and, for a rejected registration, only its status: bodies of the authorization server stay out. */
  private oauthCheckFailed(url: string, error: unknown, otherwise: McpCheckFailureReason): McpError {
    const reason = oauthFailureReason(error, otherwise);
    this.logger.warn('mcp server OAuth check failed', {
      url,
      reason,
      ...(error instanceof RegistrationRejectedError
        ? { status: error.status }
        : { error: error instanceof Error ? error.name : String(error) }),
    });
    return checkFailed(reason);
  }

  /** Runs a registry operation with one log record of its outcome, reason and duration. */
  private async logged<T>(operation: string, fields: LogFields, work: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);
    try {
      const result = await work();
      this.logger.info(`${operation} done`, { ...fields, outcome: 'done', durationMs: durationMs() });
      return result;
    } catch (error) {
      if (error instanceof McpError) {
        this.logger.warn(`${operation} refused`, {
          ...fields,
          outcome: error.code,
          reason: error.reason,
          durationMs: durationMs(),
        });
      } else {
        this.logger.error(`${operation} failed`, { ...fields, durationMs: durationMs(), error });
      }
      throw error;
    }
  }
}
