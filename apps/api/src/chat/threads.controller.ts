import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import {
  HistoryQuerySchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
  ThreadListQuerySchema,
  type AgentNode,
  type ConversationView,
  type HistoryQuery,
  type InterruptResponse,
  type RenameThreadRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadListQuery,
  type ThreadListResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { APP_LOGGER } from '../logging/app-logger';
import { type Command, runCommand } from './chat.errors';
import { ConversationsService } from './conversations.service';

/**
 * The conversation routes (design-chat.md, Contract «Беседы»): the former list, create, read, rename
 * and delete, plus the conversation view, its agent tree, send (with a record chip) and interrupt. Every
 * command is logged once with its route, ids, outcome and duration; a malformed, missing or foreign
 * `threadId` answers the same 404 `THREAD_NOT_FOUND`. The employee is always the session's (ADR-0012).
 */
@Controller('threads')
export class ThreadsController {
  private readonly logger: Logger;

  constructor(
    private readonly conversations: ConversationsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.threads' });
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(ThreadListQuerySchema)) query: ThreadListQuery,
    @Req() req: AuthedRequest,
  ): Promise<ThreadListResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /threads',
      fields: { ownerId },
      work: () => this.conversations.list(ownerId, query.cursor),
      outcomeOf: (page) => ({ count: page.threads.length }),
    });
  }

  /** The request body is not read. Only an id is handed out: the conversation appears with its first message. */
  @Post()
  @HttpCode(201)
  create(@Req() req: AuthedRequest): Promise<ThreadSummary> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /threads',
      fields: { ownerId },
      work: () => Promise.resolve(this.conversations.create()),
      outcomeOf: (thread) => ({ threadId: thread.id }),
    });
  }

  @Get(':threadId')
  get(@Param('threadId') threadId: string, @Req() req: AuthedRequest): Promise<ThreadSummary> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /threads/:threadId',
      fields: { ownerId, threadId },
      work: () => this.conversations.get(threadId, ownerId),
    });
  }

  @Get(':threadId/history')
  history(
    @Param('threadId') threadId: string,
    @Query(new ZodValidationPipe(HistoryQuerySchema)) query: HistoryQuery,
    @Req() req: AuthedRequest,
  ): Promise<ConversationView> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /threads/:threadId/history',
      fields: { ownerId, threadId },
      work: () => this.conversations.view(threadId, ownerId, query.afterSeq),
      outcomeOf: (view) => ({ chatStatus: view.chat.status, entries: view.entries.length }),
    });
  }

  @Get(':threadId/agents')
  agents(@Param('threadId') threadId: string, @Req() req: AuthedRequest): Promise<AgentNode[]> {
    const ownerId = req.user.id;
    return this.run({
      route: 'GET /threads/:threadId/agents',
      fields: { ownerId, threadId },
      work: () => this.conversations.agentsTree(threadId, ownerId),
      outcomeOf: (nodes) => ({ count: nodes.length }),
    });
  }

  @Patch(':threadId')
  rename(
    @Param('threadId') threadId: string,
    @Body(new ZodValidationPipe(RenameThreadRequestSchema)) body: RenameThreadRequest,
    @Req() req: AuthedRequest,
  ): Promise<ThreadSummary> {
    const ownerId = req.user.id;
    return this.run({
      route: 'PATCH /threads/:threadId',
      fields: { ownerId, threadId },
      work: () => this.conversations.rename(threadId, ownerId, body.title),
    });
  }

  @Delete(':threadId')
  @HttpCode(204)
  remove(@Param('threadId') threadId: string, @Req() req: AuthedRequest): Promise<void> {
    const ownerId = req.user.id;
    return this.run({
      route: 'DELETE /threads/:threadId',
      fields: { ownerId, threadId },
      work: () => this.conversations.delete(threadId, ownerId),
    });
  }

  @Post(':threadId/messages')
  @HttpCode(202)
  send(
    @Param('threadId') threadId: string,
    @Body(new ZodValidationPipe(SendMessageRequestSchema)) body: SendMessageRequest,
    @Req() req: AuthedRequest,
  ): Promise<SendMessageResponse> {
    const ownerId = req.user.id;
    const { text, recordId } = body;
    return this.run({
      route: 'POST /threads/:threadId/messages',
      fields: { ownerId, threadId, ...(recordId === undefined ? {} : { recordId }) },
      work: () => this.conversations.send(threadId, ownerId, text, recordId),
      outcomeOf: (sent) => ({ messageId: sent.messageId }),
    });
  }

  @Post(':threadId/interrupt')
  @HttpCode(200)
  interrupt(
    @Param('threadId') threadId: string,
    @Req() req: AuthedRequest,
  ): Promise<InterruptResponse> {
    const ownerId = req.user.id;
    return this.run({
      route: 'POST /threads/:threadId/interrupt',
      fields: { ownerId, threadId },
      work: () => this.conversations.interrupt(threadId, ownerId),
      outcomeOf: (answer) => ({ interruptOutcome: answer.outcome }),
    });
  }

  private run<T>(command: Command<T>): Promise<T> {
    return runCommand(this.logger, command, 'THREAD_NOT_FOUND');
  }
}
