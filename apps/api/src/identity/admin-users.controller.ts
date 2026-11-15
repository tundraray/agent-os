import { Body, Controller, Post, Req } from '@nestjs/common';
import {
  CreateLocalUserBodySchema,
  type AdminUserSummary,
  type CreateLocalUserBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOnly } from './admin-only.decorator.js';
import type { AuthedRequest } from './auth-user.js';
import { UsersService } from './users.service.js';

/** Employees for an administrator (design-identity.md, Contract «Операции администратора»). */
@Controller('admin/users')
@AdminOnly()
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  /** A local account without roles (AC-33.1): 201 `AdminUserSummary`. */
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateLocalUserBodySchema))
    body: CreateLocalUserBody,
    @Req() req: AuthedRequest,
  ): Promise<AdminUserSummary> {
    return this.users.createLocal(req.user.id, body);
  }
}
