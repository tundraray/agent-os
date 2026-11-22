import { Controller, Get, Inject, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import { loggedRoute } from '../common/logged-route';
import type { SpendResponse } from '@agent-os/contracts';
import type { AuthedRequest } from '../identity/auth-user';
import { AgentControlService } from './agent-control.service';
import { chatRoute } from './chat.errors';

/** `GET /spend` (design-chat.md, «Решения и расход»): the owner's cost in the current UTC month. */
@Controller('spend')
export class SpendController {
  private readonly logger: Logger;

  constructor(
    private readonly control: AgentControlService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.spend' });
  }

  @Get()
  spend(@Req() req: AuthedRequest): Promise<SpendResponse> {
    const ownerId = req.user.id;
    return loggedRoute(
      this.logger,
      {
        route: 'GET /spend',
        fields: { ownerId },
        work: () => this.control.spend(ownerId),
        outcomeOf: (answer) => ({ month: answer.month }),
      },
      chatRoute(),
    );
  }
}
