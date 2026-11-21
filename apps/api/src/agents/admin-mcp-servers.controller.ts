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
import type { Agents } from '@agent-os/agents';
import {
  RegisterMcpServerBodySchema,
  UpdateMcpServerBodySchema,
  type McpServerSummary,
  type McpServerView,
  type RefreshMcpToolsResponse,
  type RegisterMcpServerBody,
  type UpdateMcpServerBody,
} from '@agent-os/contracts';
import type { Response } from 'express';
import { AccessService } from '../access/access.service';
import { AuditLog } from '../audit/audit-log';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { IdentitySettings } from '../identity/identity-settings';
import { AGENTS } from './agents.tokens';
import {
  adminServerPage,
  mcpCallbackUrl,
  recordServerChange,
  refuseCrossSite,
} from './mcp-connections.controller';
import { mcpAnswer } from './mcp.errors';

/**
 * The MCP server registry for an administrator (design-mcp-connect.md, Contract «Реестр — для `admin`»).
 * Every write goes through `Agents.mcp` and is audited after it as `admin_change` on `mcp_server`; no answer
 * carries a token value (AC-13.5). The server's OAuth return address is built from `IdentitySettings.publicUrlFor`.
 * The grants on a removed server are deleted through `AccessService`: the registry does not read `access_*`.
 */
@Controller('admin/mcp-servers')
@AdminOnly()
export class AdminMcpServersController {
  constructor(
    @Inject(AGENTS) private readonly agents: Agents,
    private readonly settings: IdentitySettings,
    private readonly auditLog: AuditLog,
    private readonly access: AccessService,
  ) {}

  /** The servers by name. */
  @Get()
  list(): Promise<McpServerSummary[]> {
    return mcpAnswer(this.agents.mcp.list());
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
      await this.settings.publicUrlFor(req),
      body.name,
    );
    const write = await mcpAnswer(
      this.agents.mcp.register({ ...body, redirectUrl }),
    );
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
    return mcpAnswer(this.agents.mcp.get(name));
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
      await this.settings.publicUrlFor(req),
      name,
    );
    const started = await mcpAnswer(
      this.agents.mcp.beginConnect({
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
    const write = await mcpAnswer(this.agents.mcp.update(name, body));
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
    const refresh = await mcpAnswer(this.agents.mcp.refreshTools(name, actor));
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
   * 204: the server, its accounts and the grants on it are removed; 404 MCP_SERVER_NOT_FOUND. The grants
   * go first, in their own statement: the registry and the grants belong to different owners and share
   * no transaction, and a failure between the two must leave a server without grants, never grants
   * without a server.
   */
  @Delete(':name')
  @HttpCode(204)
  async remove(
    @Param('name') name: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = req.user.id;
    await this.access.removeServerGrants(actor, name);
    const removal = await mcpAnswer(this.agents.mcp.remove(name));
    await recordServerChange(this.auditLog, {
      actor,
      server: name,
      change: removal,
    });
  }
}
