import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type AppearanceSettings,
  UpdateAppearanceSettingsBodySchema,
  type UpdateAppearanceSettingsBody,
} from '@agent-os/contracts';
import { loggedRoute } from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { SettingsService, settingsResponse } from './settings.service';

const APPEARANCE_SETTINGS = 'appearance_settings';

/**
 * The organisation's theme for an administrator (theming design-preference.md, KD-2, Flow 4), the key
 * `appearance_settings` of `settings`. The body is checked by the contract schema (400 VALIDATION_FAILED, nothing
 * changes); `SettingsService` writes the key with its `admin_change`.
 */
@Controller('admin/appearance/settings')
@AdminOnly()
export class AdminAppearanceController {
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'settings.routes' });
  }

  /** `AppearanceSettings`. */
  @Get()
  read(@Req() req: AuthedRequest): Promise<AppearanceSettings> {
    return loggedRoute(this.logger, {
      route: 'GET /admin/appearance/settings',
      fields: { actorId: req.user.id },
      work: async () =>
        settingsResponse(await this.settings.read(APPEARANCE_SETTINGS)),
    });
  }

  /** `AppearanceSettings` after the change. */
  @Put()
  update(
    @Body(new ZodValidationPipe(UpdateAppearanceSettingsBodySchema))
    body: UpdateAppearanceSettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<AppearanceSettings> {
    const actorId = req.user.id;
    return loggedRoute(this.logger, {
      route: 'PUT /admin/appearance/settings',
      fields: { actorId },
      work: async () => {
        const { after } = await this.settings.write(
          APPEARANCE_SETTINGS,
          body,
          actorId,
        );
        return settingsResponse(after);
      },
      outcomeOf: (after) => ({ theme: after.theme }),
    });
  }
}
