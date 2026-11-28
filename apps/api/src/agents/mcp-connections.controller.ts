import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  AgentsMcp,
  type McpConnectResult,
  type McpNewToolsAuditState,
  type McpServerAuditState,
} from '@agent-os/agents';
import type { McpConnection } from '@agent-os/contracts';
import type { Response } from 'express';
import { AuditLog } from '../audit/audit-log';
import type { AuthedRequest } from '../identity/auth-user';
import { identityError } from '../identity/identity.errors';
import { IdentitySettings } from '../identity/identity-settings';
import { frontendOrigin } from '../identity/session-cookie';
import { mcpAnswer } from './mcp.errors';

/** The audit object of a registry server (design-mcp-connect.md, «Реестр — для `admin`»). */
const MCP_SERVER_OBJECT_TYPE = 'mcp_server';

/** A registry write as `admin_change` on `mcp_server`, after the operation; `AuditLog` masks `sharedToken`. */
export async function recordServerChange(
  auditLog: AuditLog,
  {
    actor,
    server,
    change,
  }: {
    readonly actor: string;
    readonly server: string;
    readonly change: {
      readonly before: McpServerAuditState | McpNewToolsAuditState | null;
      readonly after: McpServerAuditState | McpNewToolsAuditState | null;
    };
  },
): Promise<void> {
  await auditLog.record({
    kind: 'admin_change',
    actor,
    objectType: MCP_SERVER_OBJECT_TYPE,
    objectId: server,
    before: change.before === null ? null : { ...change.before },
    after: change.after === null ? null : { ...change.after },
    outcome: 'ok',
  });
}

/**
 * The OAuth return address of one server, registered with its authorization server:
 * `<public address>/api/mcp/oauth/callback/<server>`. Each server has its own, so a code that an authorization
 * server sends back cannot be presented as another server's.
 */
export function mcpCallbackUrl(publicUrl: string, server: string): string {
  return `${publicUrl}/api/mcp/oauth/callback/${encodeURIComponent(server)}`;
}

/** The web's «Мой доступ» page with the outcome of a connection. */
function accountPage(query: Record<string, string>): string {
  return `${frontendOrigin()}/account?${new URLSearchParams(query).toString()}`;
}

/** The web's page of a registry server with the outcome of the admin's connection. */
export function adminServerPage(
  server: string,
  query: Record<string, string>,
): string {
  return `${frontendOrigin()}/admin/servers/${encodeURIComponent(server)}?${new URLSearchParams(query).toString()}`;
}

/** `/account?error=connect_failed&server=<name>` (the server is left out when the return matched no request). */
function employeeConnectFailed(server: string | null): string {
  return accountPage(
    server === null
      ? { error: 'connect_failed' }
      : { error: 'connect_failed', server },
  );
}

/** Where the browser goes after the return, by the outcome and the target (Contract «Подключения сотрудника»). */
function returnPage({ outcome, server, target }: McpConnectResult): string {
  if (target !== 'admin' || server === null) {
    return outcome === 'connected' && server !== null
      ? accountPage({ connected: server })
      : employeeConnectFailed(server);
  }
  switch (outcome) {
    case 'connected':
      return adminServerPage(server, { connected: '1' });
    case 'tools_failed':
      return adminServerPage(server, { error: 'tools_failed' });
    default:
      return adminServerPage(server, { error: 'connect_failed' });
  }
}

/**
 * The connect routes change state with a GET, which the guard's `Origin` check does not cover: a request the
 * browser marks `Sec-Fetch-Site: cross-site` is refused as a foreign origin is. A client that sends no such
 * header (`seed:mcp`) passes.
 */
export function refuseCrossSite(req: AuthedRequest): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw identityError('ORIGIN_REJECTED');
  }
}

/** A query parameter as a single string; a repeated or missing one is `undefined`. */
function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * An employee's MCP accounts (design-mcp-connect.md, Contract «Подключения сотрудника», KD-6). Every route,
 * the OAuth return included, is closed by the session: the return is bound to the employee who began the
 * request through the one-time `state`. The owner is only `req.user.id`; no route logs or answers a token,
 * a code or `state`.
 */
@Controller('mcp')
export class McpConnectionsController {
  constructor(
    @Inject(AgentsMcp) private readonly mcp: AgentsMcp,
    private readonly settings: IdentitySettings,
    private readonly auditLog: AuditLog,
  ) {}

  /** Enabled `oauth` servers the employee may use, by name, with his account status. */
  @Get('connections')
  connections(@Req() req: AuthedRequest): Promise<McpConnection[]> {
    const ownerId = req.user.id;
    return mcpAnswer(this.mcp.connections(ownerId));
  }

  /** 302 to the authorization server, or to `/account?error=connect_failed&server=<name>`. */
  @Get('connections/:server/connect')
  async connect(
    @Param('server') server: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    refuseCrossSite(req);
    const ownerId = req.user.id;
    const publicUrl = await this.settings.savedPublicUrl();
    const started =
      publicUrl === null
        ? ({ kind: 'refused' } as const)
        : await mcpAnswer(
            this.mcp.beginConnect({
              ownerId,
              server,
              target: 'employee',
              redirectUrl: mcpCallbackUrl(publicUrl, server),
            }),
          );
    res.redirect(
      302,
      started.kind === 'redirect'
        ? started.authorizationUrl.href
        : employeeConnectFailed(server),
    );
  }

  /**
   * The return from the authorization server at the server's own address (DC-5, DC-13): 302 to the page of
   * the target with the outcome. A return at another server's address than the request's is refused before
   * the exchange. An admin's return without the admin right is refused before the exchange and audited as `access_denied`;
   * an admin's list read with his account is audited as `admin_change`.
   */
  @Get('oauth/callback/:server')
  async callback(
    @Param('server') server: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const ownerId = req.user.id;
    const result = await mcpAnswer(
      this.mcp.finishConnect({
        ownerId,
        isAdmin: req.user.isAdmin,
        server,
        state: single(query.state) ?? '',
        code: single(query.code),
        iss: single(query.iss),
        error: single(query.error),
      }),
    );
    if (result.outcome === 'access_denied' && result.server !== null) {
      await this.auditLog.record({
        kind: 'access_denied',
        actor: ownerId,
        objectType: MCP_SERVER_OBJECT_TYPE,
        objectId: result.server,
        outcome: 'rejected',
        reason: 'admin_required',
      });
    }
    if (result.change !== undefined && result.server !== null) {
      await recordServerChange(this.auditLog, {
        actor: ownerId,
        server: result.server,
        change: result.change,
      });
    }
    res.redirect(302, returnPage(result));
  }

  /** 204, also when the employee has no account on the server. */
  @Delete('connections/:server')
  @HttpCode(204)
  async disconnect(
    @Param('server') server: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const ownerId = req.user.id;
    await mcpAnswer(this.mcp.disconnect(ownerId, server));
  }
}
