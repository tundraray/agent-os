import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  SaveRoleLevelsBodySchema,
  SaveServerAccessBodySchema,
  SaveUserLevelsBodySchema,
  type RoleLevels,
  type SaveRoleLevelsBody,
  type SaveServerAccessBody,
  type SaveUserLevelsBody,
  type ServerAccess,
  type UserLevels,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { AccessLevelsService } from './access-levels.service';

/**
 * Access levels for an administrator (access-levels KD-6, Contract «Уровни роли и сотрудника», «Доступ ролей к
 * серверу»): one read-and-replace pair for each tab — a role's tools, an employee's tools, a server's access.
 */
@Controller('admin')
@AdminOnly()
export class AdminAccessLevelsController {
  constructor(private readonly levels: AccessLevelsService) {}

  /** `RoleLevels`; 404 ROLE_NOT_FOUND. */
  @Get('roles/:id/levels')
  roleLevels(@Param('id') id: string): Promise<RoleLevels> {
    return this.levels.roleLevels(id);
  }

  /** `RoleLevels`; 404 ROLE_NOT_FOUND, 409 BUILTIN_ROLE, 422 LEVELS_INVALID. */
  @Put('roles/:id/levels')
  saveRoleLevels(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SaveRoleLevelsBodySchema))
    body: SaveRoleLevelsBody,
    @Req() req: AuthedRequest,
  ): Promise<RoleLevels> {
    return this.levels.saveRoleLevels(req.user.id, id, body);
  }

  /** `UserLevels`; 404 USER_NOT_FOUND. */
  @Get('users/:id/levels')
  userLevels(@Param('id') id: string): Promise<UserLevels> {
    return this.levels.userLevels(id);
  }

  /** `UserLevels`; 404 USER_NOT_FOUND, 422 LEVELS_INVALID. */
  @Put('users/:id/levels')
  saveUserLevels(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SaveUserLevelsBodySchema))
    body: SaveUserLevelsBody,
    @Req() req: AuthedRequest,
  ): Promise<UserLevels> {
    return this.levels.saveUserLevels(req.user.id, id, body);
  }

  /** `ServerAccess`; 404 MCP_SERVER_NOT_FOUND. */
  @Get('mcp-servers/:name/access')
  serverAccess(@Param('name') name: string): Promise<ServerAccess> {
    return this.levels.serverAccess(name);
  }

  /** `ServerAccess`; 404 MCP_SERVER_NOT_FOUND, 409 BUILTIN_ROLE, 422 LEVELS_INVALID. */
  @Put('mcp-servers/:name/access')
  saveServerAccess(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(SaveServerAccessBodySchema))
    body: SaveServerAccessBody,
    @Req() req: AuthedRequest,
  ): Promise<ServerAccess> {
    return this.levels.saveServerAccess(req.user.id, name, body);
  }
}
