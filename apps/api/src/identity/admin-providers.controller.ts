import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import {
  CreateProviderBodySchema,
  UpdateProviderBodySchema,
  type CreateProviderBody,
  type ProviderList,
  type ProviderView,
  type UpdateProviderBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminOnly } from './admin-only.decorator.js';
import type { AuthedRequest } from './auth-user.js';
import { ProvidersService } from './providers.service.js';

/** Sign-in providers for an administrator (design-identity.md, Contract «Операции администратора»). */
@Controller('admin/providers')
@AdminOnly()
export class AdminProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  /** The providers in creation order. */
  @Get()
  list(): Promise<ProviderList> {
    return this.providers.list();
  }

  /** `ProviderView`; 404 PROVIDER_NOT_FOUND. */
  @Get(':id')
  detail(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ProviderView> {
    return this.providers.detail(id, req);
  }

  /** 201 `ProviderView` of a disabled provider; 400 `unknown_type`, 422 PROVIDER_CHECK_FAILED. */
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateProviderBodySchema))
    body: CreateProviderBody,
    @Req() req: AuthedRequest,
  ): Promise<ProviderView> {
    return this.providers.create(req.user.id, body, req);
  }

  /** `ProviderView`; 404 PROVIDER_NOT_FOUND, 409 PROVIDER_INCOMPLETE, 422 PROVIDER_CHECK_FAILED. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateProviderBodySchema))
    body: UpdateProviderBody,
    @Req() req: AuthedRequest,
  ): Promise<ProviderView> {
    return this.providers.update(req.user.id, id, body, req);
  }
}
