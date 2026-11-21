import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  CreateRoleBodySchema,
  UpdateRoleBodySchema,
  type AdminUserDetail,
  type CreateRoleBody,
  type RoleDetail,
  type RoleList,
  type RoleSummary,
  type UpdateRoleBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from './admin-only.decorator';
import type { AuthedRequest } from './auth-user';
import { RolesService } from './roles.service';

/** Roles and their assignment for an administrator (design-identity.md, Contract «Операции администратора»). */
@Controller('admin')
@AdminOnly()
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  /** The roles by name with the employee count, `isAdmin` and `builtin`. */
  @Get('roles')
  list(): Promise<RoleList> {
    return this.roles.list();
  }

  /** One role with its employees; 404 ROLE_NOT_FOUND. */
  @Get('roles/:id')
  detail(@Param('id') id: string): Promise<RoleDetail> {
    return this.roles.detail(id);
  }

  /** 201 `RoleSummary`; 409 ROLE_NAME_TAKEN. */
  @Post('roles')
  create(
    @Body(new ZodValidationPipe(CreateRoleBodySchema))
    body: CreateRoleBody,
    @Req() req: AuthedRequest,
  ): Promise<RoleSummary> {
    return this.roles.create(req.user.id, body);
  }

  /** Returns the role as `GET roles/:id` does; 409 ROLE_NAME_TAKEN, BUILTIN_ROLE. */
  @Patch('roles/:id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRoleBodySchema))
    body: UpdateRoleBody,
    @Req() req: AuthedRequest,
  ): Promise<RoleDetail> {
    return this.roles.update(req.user.id, id, body);
  }

  /** 204; the assignments go with the role. 409 BUILTIN_ROLE. */
  @Delete('roles/:id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.roles.remove(req.user.id, id);
  }

  /** Assigns the role; returns the employee as `GET users/:id` does. */
  @Put('users/:id/roles/:roleId')
  assign(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserDetail> {
    return this.roles.assign(req.user.id, id, roleId);
  }

  /** Takes the role; returns the employee as `GET users/:id` does. */
  @Delete('users/:id/roles/:roleId')
  unassign(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserDetail> {
    return this.roles.unassign(req.user.id, id, roleId);
  }
}
