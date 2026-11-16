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
  Query,
  Req,
} from '@nestjs/common';
import { McpError, type Agents } from '@agent-os/agents';
import {
  CreateGrantBodySchema,
  McpErrorCode,
  UpdateGrantBodySchema,
  type CreateGrantBody,
  type Grant,
  type UpdateGrantBody,
} from '@agent-os/contracts';
import { AGENTS } from '../agents/agents.tokens.js';
import { apiError } from '../common/api-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOnly } from '../identity/admin-only.decorator.js';
import type { AuthedRequest } from '../identity/auth-user.js';
import { AccessService, type McpGrantTarget } from './access.service.js';
import type { GrantHolderQuery } from './grants.repository.js';

/** Exactly one of `roleId` and `userId`; anything else is 400 VALIDATION_FAILED. */
function holderQuery(
  roleId: string | undefined,
  userId: string | undefined,
): GrantHolderQuery {
  if (roleId !== undefined && userId === undefined) return { roleId };
  if (userId !== undefined && roleId === undefined) return { userId };
  throw apiError(
    400,
    'VALIDATION_FAILED',
    'exactly one of roleId and userId is required',
  );
}

/**
 * Grants of roles and employees for an administrator (design-access.md, Contract «Операции
 * администратора»). A server or tool target is checked against the MCP registry through
 * `Agents.mcp.get` (ADR-0014); the service audits every write in the write's transaction.
 */
@Controller('admin/grants')
@AdminOnly()
export class AdminAccessController {
  constructor(
    private readonly access: AccessService,
    @Inject(AGENTS) private readonly agents: Agents,
  ) {}

  /** `?roleId=` or `?userId=`: the holder's grants by creation time; 404 ROLE_NOT_FOUND, USER_NOT_FOUND. */
  @Get()
  list(
    @Query('roleId') roleId: string | undefined,
    @Query('userId') userId: string | undefined,
  ): Promise<Grant[]> {
    return this.access.listGrants(holderQuery(roleId, userId));
  }

  /** 201 `Grant`; 422 GRANT_INVALID, GRANT_TARGET_UNKNOWN; 409 GRANT_EXISTS. */
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateGrantBodySchema)) body: CreateGrantBody,
    @Req() req: AuthedRequest,
  ): Promise<Grant> {
    return this.access.createGrant(req.user.id, body, (target) =>
      this.mcpTargetCheck(target),
    );
  }

  /** The quota of a model allow; `null` removes it. 404 GRANT_NOT_FOUND, 422 GRANT_INVALID. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateGrantBodySchema)) body: UpdateGrantBody,
    @Req() req: AuthedRequest,
  ): Promise<Grant> {
    return this.access.updateGrantQuota(req.user.id, id, body.quotaUsd);
  }

  /** 204; 404 GRANT_NOT_FOUND. */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.access.deleteGrant(req.user.id, id);
  }

  /** The server is in the registry and, for a tool target, the tool is in its list. */
  private async mcpTargetCheck(
    target: McpGrantTarget,
  ): Promise<'server_unknown' | 'tool_unknown' | null> {
    try {
      const server = await this.agents.mcp.get(target.server);
      if (
        target.kind === 'tool' &&
        !server.tools.some((tool) => tool.name === target.tool)
      )
        return 'tool_unknown';
      return null;
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === McpErrorCode.MCP_SERVER_NOT_FOUND
      )
        return 'server_unknown';
      throw error;
    }
  }
}
