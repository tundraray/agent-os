import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type OrganisationInstructions,
  UpdateOrganisationInstructionsBodySchema,
  type UpdateOrganisationInstructionsBody,
} from '@agent-os/contracts';
import { loggedRoute } from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOnly } from '../identity/admin-only.decorator';
import type { AuthedRequest } from '../identity/auth-user';
import { SettingsService, settingsResponse } from './settings.service';

const ORGANISATION_INSTRUCTIONS = 'organisation_instructions';

/**
 * The organisation's instruction for an administrator (agent-guidance design-server.md, KD-4, Flow 4), the key
 * `organisation_instructions` of `settings`. The body is checked by the contract schema (400 VALIDATION_FAILED,
 * nothing changes); `SettingsService` writes the key with its `admin_change`. The text is not secret (PRD): it
 * goes to the audit and the log whole.
 */
@Controller('admin/instructions')
@AdminOnly()
export class AdminInstructionsController {
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'settings.routes' });
  }

  /** `OrganisationInstructions`. */
  @Get()
  read(@Req() req: AuthedRequest): Promise<OrganisationInstructions> {
    return loggedRoute(this.logger, {
      route: 'GET /admin/instructions',
      fields: { actorId: req.user.id },
      work: async () =>
        settingsResponse(await this.settings.read(ORGANISATION_INSTRUCTIONS)),
    });
  }

  /** `OrganisationInstructions` after the change. */
  @Put()
  update(
    @Body(new ZodValidationPipe(UpdateOrganisationInstructionsBodySchema))
    body: UpdateOrganisationInstructionsBody,
    @Req() req: AuthedRequest,
  ): Promise<OrganisationInstructions> {
    const actorId = req.user.id;
    return loggedRoute(this.logger, {
      route: 'PUT /admin/instructions',
      fields: { actorId },
      work: async () => {
        const { after } = await this.settings.write(
          ORGANISATION_INSTRUCTIONS,
          body,
          actorId,
        );
        return settingsResponse(after);
      },
      outcomeOf: (after) => ({ textChars: after.text.length }),
    });
  }
}
