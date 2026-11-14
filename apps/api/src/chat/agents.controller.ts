import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  AgentListQuerySchema,
  HistoryQuerySchema,
  InterruptRequestSchema,
  SendMessageRequestSchema,
  type AgentListPage,
  type AgentListQuery,
  type AgentPageView,
  type AwaitingCount,
  type HistoryQuery,
  type InheritedHistory,
  type InterruptResponse,
  type RestartResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type StopResponse,
  type WorkflowRunView,
} from '@agent-os/contracts';
import type { AuthedRequest } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { AgentControlService } from './agent-control.service.js';
import { type Command, runCommand } from './chat.errors.js';

/** The body of an interrupt may be absent: no text is the same as `{}`. */
const interruptBody = new ZodValidationPipe(InterruptRequestSchema);

/**
 * The agent routes (design-chat.md, Contract «Агенты»). A malformed, missing or foreign `agentId`, and
 * the id of a conversation's root, answer the same 404 `AGENT_NOT_FOUND`; every command is logged once
 * with its route, ids, outcome and duration. `awaiting` is declared before the `:agentId` routes.
 */
@Controller('agents')
@UseGuards(SessionGuard)
export class AgentsController {
  private readonly logger: Logger;

  constructor(
    private readonly control: AgentControlService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.agents' });
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(AgentListQuerySchema)) query: AgentListQuery,
    @Req() req: AuthedRequest,
  ): Promise<AgentListPage> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents',
      fields: { ownerId },
      work: () => this.control.page(ownerId, query.cursor),
      outcomeOf: (page) => ({ count: page.agents.length }),
    });
  }

  @Get('awaiting')
  awaiting(@Req() req: AuthedRequest): Promise<AwaitingCount> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents/awaiting',
      fields: { ownerId },
      work: () => this.control.awaiting(ownerId),
      outcomeOf: (awaiting) => ({ count: awaiting.count }),
    });
  }

  @Get(':agentId/history')
  history(
    @Param('agentId') agentId: string,
    @Query(new ZodValidationPipe(HistoryQuerySchema)) query: HistoryQuery,
    @Req() req: AuthedRequest,
  ): Promise<AgentPageView> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents/:agentId/history',
      fields: { ownerId, agentId },
      work: () => this.control.history(agentId, ownerId, query.afterSeq),
      outcomeOf: (page) => ({ agentStatus: page.agent.status, entries: page.entries.length }),
    });
  }

  @Get(':agentId/inherited')
  inherited(
    @Param('agentId') agentId: string,
    @Query(new ZodValidationPipe(HistoryQuerySchema)) query: HistoryQuery,
    @Req() req: AuthedRequest,
  ): Promise<InheritedHistory> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents/:agentId/inherited',
      fields: { ownerId, agentId },
      work: () => this.control.inherited(agentId, ownerId, query.afterSeq),
      outcomeOf: (page) => ({ entries: page.entries.length }),
    });
  }

  @Get(':agentId/run')
  workflowRun(
    @Param('agentId') agentId: string,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowRunView> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents/:agentId/run',
      fields: { ownerId, agentId },
      work: () => this.control.run(agentId, ownerId),
      outcomeOf: (run) => ({ steps: run.steps.length }),
    });
  }

  @Post(':agentId/messages')
  @HttpCode(202)
  send(
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(SendMessageRequestSchema)) body: SendMessageRequest,
    @Req() req: AuthedRequest,
  ): Promise<SendMessageResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /agents/:agentId/messages',
      fields: { ownerId, agentId },
      work: () => this.control.send(agentId, ownerId, body.text),
      outcomeOf: (sent) => ({ messageId: sent.messageId }),
    });
  }

  @Post(':agentId/interrupt')
  @HttpCode(200)
  interrupt(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<InterruptResponse> {
    const ownerId = req.user.id;
    const { text } = interruptBody.transform(body ?? {}, { type: 'body' });
    return this.run({
      route: 'POST /agents/:agentId/interrupt',
      fields: { ownerId, agentId },
      work: () => this.control.interrupt(agentId, ownerId, text),
      outcomeOf: (answer) => ({ interruptOutcome: answer.outcome, withText: text !== undefined }),
    });
  }

  @Post(':agentId/stop')
  @HttpCode(200)
  stop(@Param('agentId') agentId: string, @Req() req: AuthedRequest): Promise<StopResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /agents/:agentId/stop',
      fields: { ownerId, agentId },
      work: () => this.control.stop(agentId, ownerId),
      outcomeOf: (answer) => ({ stopped: answer.stopped.length }),
    });
  }

  @Post(':agentId/restart')
  @HttpCode(201)
  restart(@Param('agentId') agentId: string, @Req() req: AuthedRequest): Promise<RestartResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /agents/:agentId/restart',
      fields: { ownerId, agentId },
      work: () => this.control.restart(agentId, ownerId),
      outcomeOf: (answer) => ({ restartedAs: answer.agentId }),
    });
  }

  private run<T>(command: Command<T>): Promise<T> {
    return runCommand(this.logger, command, 'AGENT_NOT_FOUND');
  }
}
