import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  AdminUserListQuerySchema,
  CreateLocalUserBodySchema,
  ResetPasswordBodySchema,
  SetPersonalAdminBodySchema,
  type AdminUserDetail,
  type AdminUserListQuery,
  type AdminUserPage,
  type AdminUserSummary,
  type CreateLocalUserBody,
  type ResetPasswordBody,
  type SetPersonalAdminBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from './admin-only.decorator';
import type { AuthedRequest } from './auth-user';
import { UsersService } from './users.service';

/** Employees for an administrator (design-identity.md, Contract «Операции администратора»). */
@Controller('admin/users')
@AdminOnly()
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  /** A page of 50 by name, then id; `query` searches name, email and login ignoring case. */
  @Get()
  list(
    @Query(new ZodValidationPipe(AdminUserListQuerySchema))
    query: AdminUserListQuery,
  ): Promise<AdminUserPage> {
    return this.users.list(query);
  }

  /** A local account without roles (AC-33.1): 201 `AdminUserSummary`. */
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateLocalUserBodySchema))
    body: CreateLocalUserBody,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserSummary> {
    return this.users.createLocal(req.user.id, body);
  }

  /** The employee and where his admin right comes from; 404 USER_NOT_FOUND. */
  @Get(':id')
  detail(@Param('id') id: string): Promise<AdminUserDetail> {
    return this.users.detail(id);
  }

  /** 204; the employee's sessions are ended (DC-16). */
  @Put(':id/password')
  @HttpCode(204)
  resetPassword(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResetPasswordBodySchema))
    body: ResetPasswordBody,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.users.resetPassword(req.user.id, id, body.password);
  }

  /** Gives or takes the personal admin right; returns the employee as `GET :id` does. */
  @Put(':id/admin')
  setPersonalAdmin(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetPersonalAdminBodySchema))
    body: SetPersonalAdminBody,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserDetail> {
    return this.users.setPersonalAdmin(req.user.id, id, body.enabled);
  }

  /** Blocks the employee (Flow 4): 200 `AdminUserSummary`; his sessions are ended at once. */
  @Post(':id/block')
  @HttpCode(200)
  block(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserSummary> {
    return this.users.disable(req.user.id, id);
  }

  /** Unblocks the employee: 200 `AdminUserSummary`; old sessions stay ended. */
  @Post(':id/unblock')
  @HttpCode(200)
  unblock(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserSummary> {
    return this.users.enable(req.user.id, id);
  }
}
