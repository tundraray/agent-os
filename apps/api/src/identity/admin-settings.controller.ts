import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import {
  UpdateSignInSettingsBodySchema,
  type SignInSettings,
  type UpdateSignInSettingsBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from './admin-only.decorator';
import type { AuthedRequest } from './auth-user';
import { IdentitySettings } from './identity-settings';

/** Sign-in settings for an administrator (FR-26; design-identity.md, `SignInSettings`). */
@Controller('admin/settings/sign-in')
@AdminOnly()
export class AdminSettingsController {
  constructor(private readonly settings: IdentitySettings) {}

  @Get()
  get(): Promise<SignInSettings> {
    return this.settings.get();
  }

  /** 400 VALIDATION_FAILED for a value out of bounds, nothing changed. */
  @Put()
  update(
    @Body(new ZodValidationPipe(UpdateSignInSettingsBodySchema))
    body: UpdateSignInSettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<SignInSettings> {
    return this.settings.update(req.user.id, body);
  }
}
