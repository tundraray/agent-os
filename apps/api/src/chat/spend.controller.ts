import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import type { SpendResponse } from '@agent-os/contracts';
import type { AuthedRequest } from '../identity/auth-user';
import { APP_LOGGER } from '../logging/app-logger';
import { AgentControlService } from './agent-control.service';
import { runCommand } from './chat.errors';

/** `GET /spend` (design-chat.md, «Решения и расход»): the owner's cost in the current UTC month. */
@Controller('spend')
export class SpendController {
  private readonly logger: Logger;

  constructor(
    private readonly control: AgentControlService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.spend' });
  }

  @Get()
  spend(@Req() req: AuthedRequest): Promise<SpendResponse> {
    const ownerId = req.user.id;
    return runCommand(this.logger, {
      route: 'GET /spend',
      fields: { ownerId },
      work: () => this.control.spend(ownerId),
      outcomeOf: (answer) => ({ month: answer.month }),
    });
  }
}
