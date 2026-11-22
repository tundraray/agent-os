import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import { loggedRoute } from '../common/logged-route';
import {
  DecisionRequestSchema,
  type DecisionRequest,
  type DecisionResponse,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { AgentControlService } from './agent-control.service';
import { chatRoute } from './chat.errors';

/**
 * `POST /decisions/:decisionId` (design-chat.md, «Решения и расход», Flow 4): a decision on a request
 * of any agent of the owner. A schema-failing edit answers 400 `INVALID_ARGUMENTS` and the request
 * stays open; a malformed, missing or foreign id answers 404 `DECISION_NOT_FOUND`.
 */
@Controller('decisions')
export class DecisionsController {
  private readonly logger: Logger;

  constructor(
    private readonly control: AgentControlService,
    @Inject(LOGGER) logger: Logger,
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
    return loggedRoute(
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
      chatRoute('DECISION_NOT_FOUND'),
    );
  }
}
