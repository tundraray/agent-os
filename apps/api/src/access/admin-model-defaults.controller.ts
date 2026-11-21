import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import {
  UpdateModelDefaultsBodySchema,
  type ModelDefaults,
  type UpdateModelDefaultsBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { AccessService } from './access.service';

/**
 * The default chat and embedding models for an administrator (design-core.md of model-providers, Contract
 * «Для части `web`»). The service checks and audits the change in one transaction.
 */
@Controller('admin/model-defaults')
@AdminOnly()
export class AdminModelDefaultsController {
  constructor(private readonly access: AccessService) {}

  /** `ModelDefaults`. */
  @Get()
  read(): Promise<ModelDefaults> {
    return this.access.modelDefaults();
  }

  /** `ModelDefaults`; 422 MODEL_DEFAULT_INVALID with `reason` and the rejected id in `model` (AC-06.2). */
  @Put()
  update(
    @Body(new ZodValidationPipe(UpdateModelDefaultsBodySchema))
    body: UpdateModelDefaultsBody,
    @Req() req: AuthedRequest,
  ): Promise<ModelDefaults> {
    return this.access.setModelDefaults(req.user.id, body);
  }
}
