import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import type { SpendResponse } from '@agent-os/contracts';
import type { AuthedRequest } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { AgentControlService } from './agent-control.service.js';
import { runCommand } from './chat.errors.js';

/** `GET /spend` (design-chat.md, «Решения и расход»): the owner's cost in the current UTC month. */
@Controller('spend')
@UseGuards(SessionGuard)
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
