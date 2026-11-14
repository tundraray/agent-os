import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  DecisionRequestSchema,
  type DecisionRequest,
  type DecisionResponse,
} from '@agent-os/contracts';
import type { AuthedRequest } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { AgentControlService } from './agent-control.service.js';
import { runCommand } from './chat.errors.js';

/**
 * `POST /decisions/:decisionId` (design-chat.md, «Решения и расход», Flow 4): a decision on a request
 * of any agent of the owner. A schema-failing edit answers 400 `INVALID_ARGUMENTS` and the request
 * stays open; a malformed, missing or foreign id answers 404 `DECISION_NOT_FOUND`.
 */
@Controller('decisions')
@UseGuards(SessionGuard)
export class DecisionsController {
  private readonly logger: Logger;

  constructor(
    private readonly control: AgentControlService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.decisions' });
  }

  @Post(':decisionId')
  @HttpCode(200)
  decide(
    @Param('decisionId') decisionId: string,
    @Body(new ZodValidationPipe(DecisionRequestSchema)) body: DecisionRequest,
    @Req() req: AuthedRequest,
  ): Promise<DecisionResponse> {
    const ownerId = req.user.id;
    return runCommand(
      this.logger,
      {
        route: 'POST /decisions/:decisionId',
        fields: { ownerId, decisionId },
        work: () => this.control.decide(decisionId, ownerId, body),
        outcomeOf: (answer) => ({
          decisionOutcome: answer.outcome,
          approve: body.approve,
          withArgs: body.args !== undefined,
        }),
      },
      'DECISION_NOT_FOUND',
    );
  }
}
