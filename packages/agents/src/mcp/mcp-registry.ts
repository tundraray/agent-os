import type { LogFields, Logger } from '@agent-os/common';
import {
  McpErrorCode,
  McpServerModeSchema,
  type McpCheckFailureReason,
  type McpServerMode,
  type McpServerStatus,
  type McpServerSummary,
  type McpServerView,
  type McpToolSetting,
  type McpToolSettings,
  type McpToolView,
  type RegisterMcpServerBody,
  type UpdateMcpServerBody,
  type UpdateMcpToolBody,
} from '@agent-os/contracts';
import {
  McpServersRepository,
  Db,
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
import {
  CLIENT_INFO,
  type McpAuth,
  McpClient,
  deadlineFetch,
} from './mcp-client';
import { McpError } from './mcp-errors';
import {
  type McpFailureReason,
  failureName,
  mcpFailureReason,
  transportFailureReason,
} from './mcp-failure';
import {
  type ListedMcpTool,
  type McpTool,
  newToolsAfterRefresh,
  storedMcpTools,
  toMcpTool,
} from './mcp-tool';
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

/** The server's new marks as an audit entry of their clearing keeps them: the names of the new tools. */
export interface McpNewToolsAuditState {
  readonly newTools: readonly string[];
}

/**
 * The new marks of a server cleared: the server as the admin now sees it, and «было/стало» for `admin_change`.
 * `changed` is `false` when the server had no new tool: nothing was written and nothing is audited.
 */
export interface McpToolsReview {
  readonly view: McpServerView;
  readonly before: McpNewToolsAuditState;
  readonly after: McpNewToolsAuditState;
  readonly changed: boolean;
}

export interface McpServerRemoval {
  readonly before: McpServerAuditState;
  readonly after: null;
}

/** Registration as the admin sent it, with the server's own OAuth return address the controller built. */
export type McpServerRegistration = RegisterMcpServerBody & {
  readonly redirectUrl: string;
};

/**
 * After the admin connected his account: the list was read and stored, the server still waits for it
 * (`tools_failed`), or the server was removed meanwhile (`connect_failed`).
 */
export type McpAdminAccountCompletion =
  | { readonly outcome: 'connected'; readonly change: McpToolsRefresh }
  | { readonly outcome: 'tools_failed' | 'connect_failed' };

const CHECK_REASON_OF_FAILURE: Record<McpFailureReason, McpCheckFailureReason> =
  {
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
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  },
};

/** PKCE method the platform uses (KD-4); a server that does not announce it cannot be connected. */
const PKCE_METHOD = 'S256';

/** A credential failure before a listing (an admin token refresh that got no answer) as the check's refusal. */
export function credentialsCheckFailed(reason: McpFailureReason): McpError {
  return checkFailed(CHECK_REASON_OF_FAILURE[reason]);
}

function checkFailed(reason: McpCheckFailureReason): McpError {
  return new McpError(
    McpErrorCode.MCP_SERVER_CHECK_FAILED,
    `MCP server check failed: ${reason}`,
    reason,
  );
}

export function notFound(name: string): McpError {
  return new McpError(
    McpErrorCode.MCP_SERVER_NOT_FOUND,
    `MCP server ${name} is not registered`,
  );
}

function nameTaken(name: string): McpError {
  return new McpError(
    McpErrorCode.MCP_SERVER_NAME_TAKEN,
    `MCP server name ${name} is taken`,
  );
}

/** A failed tool listing as the reason of the check; an error outside the client's classes is a defect. */
function listingFailureReason(
  error: unknown,
  mode: McpServerMode,
): McpCheckFailureReason {
  const failure = mcpFailureReason(error, mode);
  return failure.kind === 'auth_required'
    ? 'unauthorized'
    : CHECK_REASON_OF_FAILURE[failure.reason];
}

/** A failed OAuth discovery or registration: no connection, no answer in time, or the step's own reason. */
function oauthFailureReason(
  error: unknown,
  otherwise: McpCheckFailureReason,
): McpCheckFailureReason {
  if (error instanceof RegistrationRejectedError)
    return 'registration_rejected';
  const reason = transportFailureReason(error);
  return reason === 'connection_lost' || reason === 'timeout'
    ? CHECK_REASON_OF_FAILURE[reason]
    : otherwise;
}

function bearer(mode: McpServerMode, token: string): McpAuth {
  return { mode, token: () => Promise.resolve(token) };
}

function statusOf(
  row: McpServerRow,
  tools: readonly McpTool[] | null,
): McpServerStatus {
  if (row.enabled) return 'enabled';
  return tools === null ? 'awaiting_admin_account' : 'disabled';
}

function summaryOf(
  row: McpServerRow,
  tools = storedMcpTools(row),
): McpServerSummary {
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
    readOnly: tool.readOnly,
    enabled: tool.enabled,
    isNew: tool.isNew,
    description: tool.description,
    serverReadOnly: tool.serverReadOnly,
    overridden: tool.overridden,
  };
}

/**
 * The server for the admin: whether a shared token and an OAuth client secret are set, never their values
 * (AC-13.5, AC-35.5). The row does not tell a client the admin entered from one the platform registered, so the
 * client id is shown for either.
 */
function viewOf(row: McpServerRow): McpServerView {
  const tools = storedMcpTools(row);
  return {
    ...summaryOf(row, tools),
    sharedTokenSet: row.sharedToken !== null,
    oauthClientId: row.oauthClientId,
    oauthClientSecretSet: row.oauthClientSecret !== null,
    tools: (tools ?? []).map(toolViewOf),
  };
}

function auditStateOf(
  row: McpServerRow,
  tokenChanged: boolean,
): McpServerAuditState {
  return {
    name: row.name,
    url: row.url,
    mode: row.mode,
    enabled: row.enabled,
    tools: storedMcpTools(row)?.map((tool) => tool.tool) ?? null,
    ...(tokenChanged ? { sharedToken: SECRET_MARK } : {}),
  };
}

/** A tool as an audit entry of its change keeps it: on or off, the effective class and the server's mark. */
export interface McpToolAuditState {
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly serverReadOnly: boolean | null;
}

/**
 * A tool's settings write: the tool as the admin now sees it, and «было/стало» for `admin_change`. `changed` is
 * `false` when the patch asked for the setting the tool already had: nothing was written and nothing is audited.
 */
export interface McpToolWrite {
  readonly view: McpToolView;
  readonly before: McpToolAuditState;
  readonly after: McpToolAuditState;
  readonly changed: boolean;
}

function toolAuditStateOf(tool: McpTool): McpToolAuditState {
  return {
    enabled: tool.enabled,
    readOnly: tool.readOnly,
    serverReadOnly: tool.serverReadOnly,
  };
}

/** The tool of the server's list by its name; one the list does not hold is `MCP_TOOL_NOT_FOUND`. */
function listedTool(row: McpServerRow, tool: string): McpTool {
  const found = storedMcpTools(row)?.find((listed) => listed.tool === tool);
  if (found === undefined) {
    throw new McpError(
      McpErrorCode.MCP_TOOL_NOT_FOUND,
      `MCP server ${row.name} does not list tool ${tool}`,
    );
  }
  return found;
}

/**
 * The settings with the patch of one tool applied: a field left out keeps its setting, `enabled: true` and
 * `readOnly: null` remove theirs, and a tool left with no setting leaves the object.
 */
function withSetting(
  settings: McpToolSettings,
  tool: string,
  patch: UpdateMcpToolBody,
): McpToolSettings {
  const current = settings[tool] ?? {};
  const disabled =
    patch.enabled === undefined ? current.enabled === false : !patch.enabled;
  const readOnly =
    patch.readOnly === undefined
      ? current.readOnly
      : (patch.readOnly ?? undefined);
  const next: McpToolSetting = {
    ...(disabled ? { enabled: false } : {}),
    ...(readOnly === undefined ? {} : { readOnly }),
  };
  const { [tool]: _replaced, ...others } = settings;
  return Object.keys(next).length === 0 ? others : { ...others, [tool]: next };
}

/** Whether two settings of one tool say the same; a missing one is no setting. */
function sameSetting(a: McpToolSetting = {}, b: McpToolSetting = {}): boolean {
  return a.enabled === b.enabled && a.readOnly === b.readOnly;
}

function difference(
  from: readonly string[] | null,
  without: readonly string[] | null,
): string[] {
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
    @Inject(Db) private readonly db: Db,
    @Inject(McpServersRepository)
    private readonly mcpServerRows: McpServersRepository,
    @Inject(McpClient) private readonly client: McpClient,
    @Inject(AGENTS_LOGGER) logger: Logger,
    @Inject(AGENTS_CONFIG)
    config: Pick<AgentsConfig, 'mcpCallTimeoutMs' | 'allowHttpUrls'>,
  ) {
    this.logger = logger.child({ service: 'agents.mcp' });
    this.callTimeoutMs = config.mcpCallTimeoutMs;
    this.allowHttp = config.allowHttpUrls;
  }

  async list(): Promise<McpServerSummary[]> {
    const rows = await this.mcpServerRows.list();
    return rows.map((row) => summaryOf(row));
  }

  async get(name: string): Promise<McpServerView> {
    return viewOf(await this.rowOf(name));
  }

  /**
   * Registers a checked server (DC-6): `shared` — enabled with the tools its token lists; `oauth` — the
   * platform's OAuth client registered at the server's authorization server, or the ready client the admin
   * entered, waiting for the admin's account (DC-7). A failed check stores nothing.
   */
  register(input: McpServerRegistration): Promise<McpServerWrite> {
    return this.logged(
      'mcp server registration',
      {
        server: input.name,
        mode: input.mode,
        readyOAuthClient: input.oauthClientId !== undefined,
      },
      async () => {
        const { name, url, mode } = input;
        if ((await this.mcpServerRows.find(name)) !== undefined)
          throw nameTaken(name);
        this.requireSecureUrl(url);
        const row: NewMcpServerRow =
          input.mode === 'shared'
            ? {
                name,
                url,
                mode,
                enabled: true,
                tools: await this.listChecked(
                  name,
                  url,
                  bearer('shared', input.sharedToken),
                ),
                sharedToken: input.sharedToken,
              }
            : {
                name,
                url,
                mode,
                ...(await this.oauthClientOf(input)),
              };
        const inserted = await this.mcpServerRows.insert(row);
        if (inserted === undefined) throw nameTaken(name);
        return {
          view: viewOf(inserted),
          before: null,
          after: auditStateOf(inserted, mode === 'shared'),
        };
      },
    );
  }

  /** Switches the server on or off and replaces its shared token; a new token is checked first (DC-6, DC-7). */
  update(name: string, patch: UpdateMcpServerBody): Promise<McpServerWrite> {
    const fields = {
      server: name,
      enabled: patch.enabled,
      sharedTokenReplaced: patch.sharedToken !== undefined,
    };
    return this.logged('mcp server update', fields, async () => {
      const row = await this.rowOf(name);
      if (patch.enabled === true && row.tools === null) {
        throw new McpError(
          McpErrorCode.MCP_SERVER_INCOMPLETE,
          `MCP server ${name} has no tool list yet`,
        );
      }
      if (patch.sharedToken !== undefined) {
        if (row.mode !== McpServerModeSchema.enum.shared) {
          throw new McpError(
            'VALIDATION_FAILED',
            `MCP server ${name} is in mode ${row.mode} and has no shared token`,
          );
        }
        await this.listChecked(
          name,
          row.url,
          bearer('shared', patch.sharedToken),
        );
      }
      return this.write(name, patch, patch.sharedToken !== undefined);
    });
  }

  /**
   * Reads the tool list anew with the given credentials (the shared token or the current admin's account,
   * chosen by the caller) and replaces it whole; a failed read keeps the old list. A server that waited for
   * its list is switched on with it (waiting → enabled). The added names join `new_tools`, which keeps the marks
   * of earlier refreshes; the first list marks none new (access-levels, «Настройки инструмента»).
   */
  refreshTools(name: string, auth: McpAuth): Promise<McpToolsRefresh> {
    return this.logged(
      'mcp server tools refresh',
      { server: name, mode: auth.mode },
      async () => {
        const row = await this.rowOf(name);
        const tools = await this.listChecked(name, row.url, auth);
        const before = storedMcpTools(row)?.map((tool) => tool.tool) ?? null;
        const after = tools.map((tool) => tool.tool);
        const added = difference(after, before);
        const write = await this.write(
          name,
          row.tools === null
            ? { tools, newTools: [], enabled: true }
            : {
                tools,
                newTools: newToolsAfterRefresh(row.newTools, added, after),
              },
          false,
        );
        return { ...write, added, removed: difference(before, after) };
      },
    );
  }

  /**
   * Switches one tool on or off and corrects its class; `readOnly: null` returns the class to the server's mark
   * (access-levels, «Настройки инструмента»). A tool not in the server's list is `MCP_TOOL_NOT_FOUND`. The
   * server's row is held from the read of its settings to their write, so two changes of one server made at
   * once both stay (AC-36.1).
   */
  updateTool(
    name: string,
    tool: string,
    patch: UpdateMcpToolBody,
  ): Promise<McpToolWrite> {
    const fields = {
      server: name,
      tool,
      enabled: patch.enabled,
      readOnly: patch.readOnly,
    };
    return this.logged('mcp tool update', fields, async () => {
      const change = await this.db.transaction(async () => {
        const before = await this.mcpServerRows.findForUpdate(name);
        if (before === undefined) throw notFound(name);
        listedTool(before, tool);
        const toolSettings = withSetting(before.toolSettings, tool, patch);
        if (sameSetting(before.toolSettings[tool], toolSettings[tool]))
          return { before, after: before, changed: false };
        const written = await this.mcpServerRows.update(name, { toolSettings });
        if (written === undefined) throw notFound(name);
        return { before, after: written.after, changed: true };
      });
      const after = listedTool(change.after, tool);
      return {
        view: toolViewOf(after),
        before: toolAuditStateOf(listedTool(change.before, tool)),
        after: toolAuditStateOf(after),
        changed: change.changed,
      };
    });
  }

  /**
   * «Отметить просмотренными»: clears every new mark of the server in one step, after which the server's own
   * mark of those tools applies again. The row is held from the read to the write, as in `updateTool`.
   */
  markToolsReviewed(name: string): Promise<McpToolsReview> {
    return this.logged('mcp tools review', { server: name }, async () => {
      const change = await this.db.transaction(async () => {
        const before = await this.mcpServerRows.findForUpdate(name);
        if (before === undefined) throw notFound(name);
        if (before.newTools.length === 0) return { before, after: before };
        const written = await this.mcpServerRows.update(name, { newTools: [] });
        if (written === undefined) throw notFound(name);
        return { before, after: written.after };
      });
      return {
        view: viewOf(change.after),
        before: { newTools: change.before.newTools },
        after: { newTools: change.after.newTools },
        changed: change.before !== change.after,
      };
    });
  }

  /**
   * After the admin connected his account to an `oauth` server: the list is read with his token, stored, and a
   * waiting server is switched on (Flow 1). A failed read leaves the server waiting: `tools_failed`; a server
   * removed meanwhile is `connect_failed`.
   */
  async completeAdminAccount(
    name: string,
    accessToken: string,
  ): Promise<McpAdminAccountCompletion> {
    try {
      return {
        outcome: 'connected',
        change: await this.refreshTools(name, bearer('oauth', accessToken)),
      };
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      if (error.code === McpErrorCode.MCP_SERVER_CHECK_FAILED)
        return { outcome: 'tools_failed' };
      if (error.code === McpErrorCode.MCP_SERVER_NOT_FOUND)
        return { outcome: 'connect_failed' };
      throw error;
    }
  }

  /** Removes the server; the cascade removes every account on it (AC-13.6). */
  remove(name: string): Promise<McpServerRemoval> {
    return this.logged('mcp server removal', { server: name }, async () => {
      const row = await this.mcpServerRows.delete(name);
      if (row === undefined) throw notFound(name);
      return { before: auditStateOf(row, false), after: null };
    });
  }

  private async rowOf(name: string): Promise<McpServerRow> {
    const row = await this.mcpServerRows.find(name);
    if (row === undefined) throw notFound(name);
    return row;
  }

  private async write(
    name: string,
    patch: McpServerPatch,
    tokenChanged: boolean,
  ): Promise<McpServerWrite> {
    const change = await this.db.transaction(async () =>
      this.mcpServerRows.update(name, patch),
    );
    if (change === undefined) throw notFound(name);
    return {
      view: viewOf(change.after),
      before: auditStateOf(change.before, false),
      after: auditStateOf(change.after, tokenChanged),
    };
  }

  private requireSecureUrl(url: string | URL): void {
    if (checkServerUrl(url, { allowHttp: this.allowHttp }) !== 'ok')
      throw checkFailed('insecure_url');
  }

  /** The server's tools by name as listed, or the reason the listing failed. */
  private async listChecked(
    name: string,
    url: string,
    auth: McpAuth,
  ): Promise<ListedMcpTool[]> {
    const { client, callTimeoutMs } = this;
    try {
      const listed = await client.listTools({
        url,
        auth,
        timeoutMs: callTimeoutMs,
      });
      const tools = listed
        .map((tool) => toMcpTool(name, tool))
        .sort((a, b) => a.tool.localeCompare(b.tool));
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
  private logShapes(server: string, tools: readonly ListedMcpTool[]): void {
    const shapes = tools.flatMap(({ tool, outputSchema }) =>
      outputSchema === undefined
        ? []
        : [{ tool, ...shapeBlockOf(outputSchema) }],
    );
    this.logger.info('mcp server tools listed', {
      server,
      tools: tools.length,
      withShape: shapes.length,
      longestShapeBlock: Math.max(
        0,
        ...shapes.map(({ block }) => block.length),
      ),
      truncatedShapes: shapes
        .filter(({ truncated }) => truncated)
        .map(({ tool }) => tool),
    });
  }

  /**
   * KD-4: the server answers a request without a token with 401; its protected-resource metadata names the
   * authorization server, whose metadata has PKCE `S256`. With a ready client of the admin that client is
   * stored as given; otherwise the metadata must have a registration endpoint, and the platform registers
   * as a public client with one return address, the server's own. OAuth support is decided by the protected-resource metadata,
   * never by a fallback to the server's origin.
   */
  private async oauthClientOf({
    url,
    redirectUrl,
    oauthClientId,
    oauthClientSecret,
  }: McpServerRegistration): Promise<
    Pick<NewMcpServerRow, 'oauthServer' | 'oauthClientId' | 'oauthClientSecret'>
  > {
    const fetchFn = deadlineFetch(this.callTimeoutMs);
    const resourceMetadataUrl = await this.challengeOf(url, fetchFn);
    if (resourceMetadataUrl !== undefined)
      this.requireSecureUrl(resourceMetadataUrl);
    const metadata = await this.discoverOAuthServer(
      url,
      resourceMetadataUrl,
      fetchFn,
    );
    if (oauthClientId !== undefined) {
      return {
        oauthServer: metadata,
        oauthClientId,
        oauthClientSecret: oauthClientSecret ?? null,
      };
    }
    if (metadata.registration_endpoint === undefined) {
      this.logger.warn('mcp server does not register OAuth clients', { url });
      throw checkFailed('oauth_not_supported');
    }
    this.requireSecureUrl(metadata.registration_endpoint);
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
  private async challengeOf(
    url: string,
    fetchFn: FetchLike,
  ): Promise<URL | undefined> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(PROBE_REQUEST),
      });
    } catch (error) {
      throw checkFailed(listingFailureReason(error, 'oauth'));
    }
    await response.body?.cancel();
    if (response.status === 401)
      return extractWWWAuthenticateParams(response).resourceMetadataUrl;
    this.logger.warn('mcp server did not ask for a token', {
      url,
      status: response.status,
    });
    throw checkFailed(response.ok ? 'oauth_not_supported' : 'not_mcp');
  }

  /** Authorization server metadata that allows PKCE, its addresses passing the address rule. */
  private async discoverOAuthServer(
    url: string,
    resourceMetadataUrl: URL | undefined,
    fetchFn: FetchLike,
  ): Promise<AuthorizationServerMetadata> {
    let info: OAuthServerInfo;
    try {
      info = await discoverOAuthServerInfo(url, {
        resourceMetadataUrl,
        fetchFn,
      });
    } catch (error) {
      throw this.oauthCheckFailed(url, error, 'oauth_not_supported');
    }
    const metadata = info.authorizationServerMetadata;
    const announced =
      (info.resourceMetadata?.authorization_servers?.length ?? 0) > 0;
    if (
      !announced ||
      metadata === undefined ||
      !(metadata.code_challenge_methods_supported ?? []).includes(PKCE_METHOD)
    ) {
      this.logger.warn('mcp server has no usable OAuth metadata', {
        url,
        resourceMetadata: info.resourceMetadata !== undefined,
        authorizationServerMetadata: metadata !== undefined,
      });
      throw checkFailed('oauth_not_supported');
    }
    for (const address of [
      info.authorizationServerUrl,
      metadata.issuer,
      metadata.authorization_endpoint,
      metadata.token_endpoint,
    ]) {
      this.requireSecureUrl(address);
    }
    return metadata;
  }

  /** Logs the error class and, for a rejected registration, only its status: bodies of the authorization server stay out. */
  private oauthCheckFailed(
    url: string,
    error: unknown,
    otherwise: McpCheckFailureReason,
  ): McpError {
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
  private async logged<T>(
    operation: string,
    fields: LogFields,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);
    try {
      const result = await work();
      this.logger.info(`${operation} done`, {
        ...fields,
        outcome: 'done',
        durationMs: durationMs(),
      });
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
        this.logger.error(`${operation} failed`, {
          ...fields,
          durationMs: durationMs(),
          error,
        });
      }
      throw error;
    }
  }
}
