import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { AgentsMcp } from '@agent-os/agents';
import {
  McpServerNameSchema,
  RegisterMcpServerBodySchema,
  UpdateMcpServerBodySchema,
  UpdateMcpToolBodySchema,
  type McpCallbackUrl,
  type McpServerSummary,
  type McpServerView,
  type McpToolView,
  type RefreshMcpToolsResponse,
  type RegisterMcpServerBody,
  type UpdateMcpServerBody,
  type UpdateMcpToolBody,
} from '@agent-os/contracts';
import type { Response } from 'express';
import { AuditLog } from '../audit/audit-log';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { IdentitySettings } from '../identity/identity-settings';
import {
  adminServerPage,
  mcpCallbackUrl,
  recordServerChange,
  refuseCrossSite,
} from './mcp-connections.controller';
import { mcpAnswer } from './mcp.errors';

/** The audit object of one tool's settings: id `<server>/<tool>`. */
const MCP_TOOL_OBJECT_TYPE = 'mcp_tool';

/**
 * The MCP server registry for an administrator (design-mcp-connect.md, Contract «Реестр — для `admin`»).
 * Every write goes through `AgentsMcp` and is audited after it as `admin_change` on `mcp_server`; no answer
 * carries a token value (AC-13.5). The server's OAuth return address is built from `IdentitySettings.publicUrlFor`.
 */
@Controller('admin/mcp-servers')
@AdminOnly()
export class AdminMcpServersController {
  constructor(
    @Inject(AgentsMcp) private readonly mcp: AgentsMcp,
    private readonly settings: IdentitySettings,
    private readonly auditLog: AuditLog,
  ) {}

  /** The servers by name. */
  @Get()
  list(): Promise<McpServerSummary[]> {
    return mcpAnswer(this.mcp.list());
  }

  /** 201 `McpServerView`; 409 MCP_SERVER_NAME_TAKEN, 422 MCP_SERVER_CHECK_FAILED with `reason`. */
  @Post()
  async register(
    @Body(new ZodValidationPipe(RegisterMcpServerBodySchema))
    body: RegisterMcpServerBody,
    @Req() req: AuthedRequest,
  ): Promise<McpServerView> {
    const actor = req.user.id;
    const redirectUrl = mcpCallbackUrl(
      await this.settings.publicUrlFor(),
      body.name,
    );
    const write = await mcpAnswer(this.mcp.register({ ...body, redirectUrl }));
    await recordServerChange(this.auditLog, {
      actor,
      server: body.name,
      change: write,
    });
    return write.view;
  }

  /** `McpServerView`; 404 MCP_SERVER_NOT_FOUND. */
  @Get(':name')
  detail(@Param('name') name: string): Promise<McpServerView> {
    return mcpAnswer(this.mcp.get(name));
  }

  /**
   * The OAuth return address (Redirect URI) of a server of that name, registered or not yet (AC-35.1): the one
   * registration sends to the authorization server. 400 for a name the registration would refuse.
   */
  @Get(':name/callback-url')
  async callbackUrl(
    @Param('name', new ZodValidationPipe(McpServerNameSchema)) name: string,
  ): Promise<McpCallbackUrl> {
    return { url: mcpCallbackUrl(await this.settings.publicUrlFor(), name) };
  }

  /** 302 to the authorization server with the admin target, or to `/admin/servers/<name>?error=connect_failed`. */
  @Get(':name/connect')
  async connect(
    @Param('name') name: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    refuseCrossSite(req);
    const ownerId = req.user.id;
    const redirectUrl = mcpCallbackUrl(
      await this.settings.publicUrlFor(),
      name,
    );
    const started = await mcpAnswer(
      this.mcp.beginConnect({
        ownerId,
        server: name,
        target: 'admin',
        redirectUrl,
      }),
    );
    res.redirect(
      302,
      started.kind === 'redirect'
        ? started.authorizationUrl.href
        : adminServerPage(name, { error: 'connect_failed' }),
    );
  }

  /** `McpServerView`; 404, 409 MCP_SERVER_INCOMPLETE, 422 MCP_SERVER_CHECK_FAILED, 400 a token for `oauth`. */
  @Patch(':name')
  async update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateMcpServerBodySchema))
    body: UpdateMcpServerBody,
    @Req() req: AuthedRequest,
  ): Promise<McpServerView> {
    const actor = req.user.id;
    const write = await mcpAnswer(this.mcp.update(name, body));
    await recordServerChange(this.auditLog, {
      actor,
      server: name,
      change: write,
    });
    return write.view;
  }

  /** The list read anew; 409 MCP_ACCOUNT_REQUIRED, 422 MCP_SERVER_CHECK_FAILED with the old list kept. */
  @Post(':name/tools/refresh')
  @HttpCode(200)
  async refreshTools(
    @Param('name') name: string,
    @Req() req: AuthedRequest,
  ): Promise<RefreshMcpToolsResponse> {
    const actor = req.user.id;
    const refresh = await mcpAnswer(this.mcp.refreshTools(name, actor));
    await recordServerChange(this.auditLog, {
      actor,
      server: name,
      change: refresh,
    });
    return {
      server: refresh.view,
      added: [...refresh.added],
      removed: [...refresh.removed],
    };
  }

  /**
   * «Отметить просмотренными»: every new mark of the server cleared in one step, so its tools take the server's
   * own mark again: `McpServerView`; 404 MCP_SERVER_NOT_FOUND. Audited as `admin_change` on `mcp_server` with the
   * new tool names before and after; a server without new tools writes and audits nothing.
   */
  @Post(':name/tools/reviewed')
  @HttpCode(200)
  async markToolsReviewed(
    @Param('name') name: string,
    @Req() req: AuthedRequest,
  ): Promise<McpServerView> {
    const review = await mcpAnswer(this.mcp.markToolsReviewed(name));
    if (review.changed) {
      await recordServerChange(this.auditLog, {
        actor: req.user.id,
        server: name,
        change: review,
      });
    }
    return review.view;
  }

  /**
   * One tool switched on or off or its class corrected (access-levels, «Настройки инструмента»): `McpToolView`;
   * 404 MCP_SERVER_NOT_FOUND, MCP_TOOL_NOT_FOUND. Audited as `admin_change` on `mcp_tool` `<server>/<tool>`,
   * after the write like every registry write; a PATCH that changes nothing writes and audits nothing.
   */
  @Patch(':name/tools/:tool')
  async updateTool(
    @Param('name') name: string,
    @Param('tool') tool: string,
    @Body(new ZodValidationPipe(UpdateMcpToolBodySchema))
    body: UpdateMcpToolBody,
    @Req() req: AuthedRequest,
  ): Promise<McpToolView> {
    const write = await mcpAnswer(this.mcp.updateTool(name, tool, body));
    if (write.changed) {
      await this.auditLog.record({
        kind: 'admin_change',
        actor: req.user.id,
        objectType: MCP_TOOL_OBJECT_TYPE,
        objectId: `${name}/${tool}`,
        before: { ...write.before },
        after: { ...write.after },
        outcome: 'ok',
      });
    }
    return write.view;
  }

  /**
   * 204: the server is removed, and its accounts and the grants on it with it by the database's cascade;
   * 404 MCP_SERVER_NOT_FOUND.
   */
  @Delete(':name')
  @HttpCode(204)
  async remove(
    @Param('name') name: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = req.user.id;
    const removal = await mcpAnswer(this.mcp.remove(name));
    await recordServerChange(this.auditLog, {
      actor,
      server: name,
      change: removal,
    });
  }
}
