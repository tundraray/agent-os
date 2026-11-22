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
} from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import { loggedRoute } from '../common/logged-route';
import {
  AgentListQuerySchema,
  HistoryQuerySchema,
  SendMessageRequestSchema,
  type AgentListPage,
  type AgentListQuery,
  type AgentPageView,
  type AwaitingCount,
  type DeepAgentRunView,
  type HistoryQuery,
  type InheritedHistory,
  type InterruptResponse,
  type RestartResponse,
  type AgentTasksView,
  type SendMessageRequest,
  type SendMessageResponse,
  type StopResponse,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { AgentControlService } from './agent-control.service';
import { chatRoute, type Command } from './chat.errors';

/**
 * The agent routes (design-chat.md, Contract «Агенты»). A malformed, missing or foreign `agentId`, and
 * the id of a conversation's root, answer the same 404 `AGENT_NOT_FOUND`; every command is logged once
 * with its route, ids, outcome and duration. `awaiting` is declared before the `:agentId` routes.
 */
@Controller('agents')
export class AgentsController {
  private readonly logger: Logger;

  constructor(
    private readonly control: AgentControlService,
    @Inject(LOGGER) logger: Logger,
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
      outcomeOf: (page) => ({
        agentStatus: page.agent.status,
        entries: page.entries.length,
      }),
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
  deepAgentRun(
    @Param('agentId') agentId: string,
    @Req() req: AuthedRequest,
  ): Promise<DeepAgentRunView> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents/:agentId/run',
      fields: { ownerId, agentId },
      work: () => this.control.run(agentId, ownerId),
      outcomeOf: (run) => ({
        recordId: run.origin.recordId,
        steps: run.steps.length,
        limitRefusals: run.limitRefusals.length,
      }),
    });
  }

  @Get(':agentId/tasks')
  tasks(
    @Param('agentId') agentId: string,
    @Req() req: AuthedRequest,
  ): Promise<AgentTasksView> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /agents/:agentId/tasks',
      fields: { ownerId, agentId },
      work: () => this.control.tasks(agentId, ownerId),
      outcomeOf: (list) => ({ tasks: list.tasks.length }),
    });
  }

  @Post(':agentId/messages')
  @HttpCode(202)
  send(
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(SendMessageRequestSchema))
    body: SendMessageRequest,
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
    @Req() req: AuthedRequest,
  ): Promise<InterruptResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /agents/:agentId/interrupt',
      fields: { ownerId, agentId },
      work: () => this.control.interrupt(agentId, ownerId),
      outcomeOf: (answer) => ({ interruptOutcome: answer.outcome }),
    });
  }

  @Post(':agentId/stop')
  @HttpCode(200)
  stop(
    @Param('agentId') agentId: string,
    @Req() req: AuthedRequest,
  ): Promise<StopResponse> {
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
  restart(
    @Param('agentId') agentId: string,
    @Req() req: AuthedRequest,
  ): Promise<RestartResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /agents/:agentId/restart',
      fields: { ownerId, agentId },
      work: () => this.control.restart(agentId, ownerId),
      outcomeOf: (answer) => ({ restartedAs: answer.agentId }),
    });
  }

  private run<T>(command: Command<T>): Promise<T> {
    return loggedRoute(this.logger, command, chatRoute('AGENT_NOT_FOUND'));
  }
}
