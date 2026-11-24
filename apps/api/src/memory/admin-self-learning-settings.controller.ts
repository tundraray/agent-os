import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  UpdateSelfLearningSettingsBodySchema,
  type SelfLearningSettings,
  type UpdateSelfLearningSettingsBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { loggedRoute } from '../common/logged-route';
import {
  SettingsService,
  settingsResponse,
} from '../settings/settings.service';

const SELF_LEARNING_SETTINGS = 'self_learning_settings';

/**
 * The self-learning settings for an administrator (self-learning design-memory.md KD-6), the key
 * `self_learning_settings` of `settings`: the size of the memory index. The body is checked by the contract schema
 * (400 VALIDATION_FAILED, nothing changes); `SettingsService` writes the key with its `admin_change`.
 */
@Controller('admin/self-learning')
@AdminOnly()
export class AdminSelfLearningSettingsController {
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'self-learning.routes' });
  }

  /** `SelfLearningSettings`. */
  @Get('settings')
  read(@Req() req: AuthedRequest): Promise<SelfLearningSettings> {
    return loggedRoute(this.logger, {
      route: 'GET /admin/self-learning/settings',
      fields: { actorId: req.user.id },
      work: async () =>
        settingsResponse(await this.settings.read(SELF_LEARNING_SETTINGS)),
    });
  }

  /** `SelfLearningSettings` after the change. */
  @Put('settings')
  update(
    @Body(new ZodValidationPipe(UpdateSelfLearningSettingsBodySchema))
    body: UpdateSelfLearningSettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<SelfLearningSettings> {
    const actorId = req.user.id;
    return loggedRoute(this.logger, {
      route: 'PUT /admin/self-learning/settings',
      fields: { actorId },
      work: async () => {
        const { after } = await this.settings.write(
          SELF_LEARNING_SETTINGS,
          body,
          actorId,
        );
        return settingsResponse(after);
      },
      outcomeOf: (after) => ({ memoryIndexTokens: after.memoryIndexTokens }),
    });
  }
}
