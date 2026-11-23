import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  UpdateToolResultSettingsBodySchema,
  type ToolResultSettings,
  type UpdateToolResultSettingsBody,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { loggedRoute } from '../common/logged-route';
import {
  SettingsService,
  settingsResponse,
} from '../settings/settings.service';

const TOOL_RESULT_SETTINGS = 'tool_result_settings';

/** The route's log outcome: the three values. */
function settingsValues(settings: ToolResultSettings): Record<string, unknown> {
  return {
    storeFromChars: settings.storeFromChars,
    previewChars: settings.previewChars,
    readMaxTokens: settings.readMaxTokens,
  };
}

/**
 * The settings of large tool results for an administrator (tool-result-reading R-5), the key `tool_result_settings`
 * of `settings` (data-model KD-3): the threshold of a stored result, its preview and one reading page. The body is
 * checked by the contract schema (400 VALIDATION_FAILED, nothing changes); `SettingsService` writes the key with its
 * `admin_change`. The next MCP call reads the new value: no restart.
 */
@Controller('admin/tool-results')
@AdminOnly()
export class AdminToolResultsController {
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'tool-results.routes' });
  }

  /** `ToolResultSettings`. */
  @Get('settings')
  read(@Req() req: AuthedRequest): Promise<ToolResultSettings> {
    return loggedRoute(this.logger, {
      route: 'GET /admin/tool-results/settings',
      fields: { actorId: req.user.id },
      work: async () =>
        settingsResponse(await this.settings.read(TOOL_RESULT_SETTINGS)),
    });
  }

  /** `ToolResultSettings` after the change. */
  @Put('settings')
  update(
    @Body(new ZodValidationPipe(UpdateToolResultSettingsBodySchema))
    body: UpdateToolResultSettingsBody,
    @Req() req: AuthedRequest,
  ): Promise<ToolResultSettings> {
    const actorId = req.user.id;
    return loggedRoute(this.logger, {
      route: 'PUT /admin/tool-results/settings',
      fields: { actorId },
      work: async () => {
        const { after } = await this.settings.write(
          TOOL_RESULT_SETTINGS,
          body,
          actorId,
        );
        return settingsResponse(after);
      },
      outcomeOf: settingsValues,
    });
  }
}
