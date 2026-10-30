import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Mastra } from '@mastra/core/mastra';
import type { MessageListInput } from '@mastra/core/agent/message-list';
import { toAISdkStream } from '@mastra/ai-sdk';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import { ChatMessageRefSchema } from '@agent-os/contracts';
import { MASTRA } from '../mastra/mastra.constants.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { toStreamErrorText } from '../common/stream-error-text.js';
import { ThreadRunRegistry } from '../threads/thread-run-registry.js';
import { ThreadTitleService } from '../threads/thread-title.service.js';
import { threadNotFound } from '../threads/threads.errors.js';
import { ThreadsService } from '../threads/threads.service.js';
import { ChatDto } from './chat.dto.js';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    @Inject(MASTRA) private readonly mastra: Mastra,
    private readonly threads: ThreadsService,
    private readonly titles: ThreadTitleService,
    private readonly runs: ThreadRunRegistry,
  ) {}

  @Post(':agentId')
  @UseGuards(SessionGuard)
  async chat(
    @Param('agentId') agentId: string,
    @Body() body: ChatDto,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    let agent;
    try {
      agent = this.mastra.getAgent(agentId);
    } catch {
      throw new NotFoundException(`Unknown agent: ${agentId}`);
    }
    const threadId = body.threadId ?? body.id;
    if (!threadId) throw new BadRequestException('threadId or id is required');
    // Registered before the ownership check, so a delete started at any later
    // moment either sees this run or has already marked the thread (KD-6).
    const run = this.runs.register(threadId);
    let outputCreated = false;
    try {
      await this.threads.getOwnedThread(threadId, req.user.id);

      // AC-14.6: a regenerate resends the newest user message; its stored replies
      // are discarded before the agent writes the new one. Only a last element
      // parsed with role `user` is checked; anything else is an ordinary send.
      const lastMessage = ChatMessageRefSchema.safeParse(body.messages.at(-1));
      if (lastMessage.success && lastMessage.data.role === 'user') {
        await this.threads.discardRepliesAfter({
          threadId,
          userId: req.user.id,
          userMessageId: lastMessage.data.id,
        });
      }

      // A delete of the thread started meanwhile has cancelled the run: answer before any SSE.
      if (run.signal.aborted) throw threadNotFound();

      // Express has no req.signal: abort generation when the client disconnects (closed tab).
      res.on('close', () => {
        if (!res.writableFinished) run.abort();
      });

      const stream = await agent.stream(body.messages as MessageListInput, {
        memory: { thread: threadId, resource: req.user.id },
        abortSignal: run.signal,
        onFinish: ({ totalUsage: u }) => {
          this.logger.log(
            `usage agent=${agentId} thread=${threadId} input=${u.inputTokens ?? 0} ` +
              `cacheRead=${u.cachedInputTokens ?? 0} cacheWrite=${u.cacheCreationInputTokens ?? 0} ` +
              `output=${u.outputTokens ?? 0}`,
          );
          // FR-17: background auto-title; never throws, an untitled thread retries on the next reply.
          this.titles.schedule({ threadId, resourceId: req.user.id });
        },
      });

      // The run is over once Mastra has read its stream to the end, including the
      // end-of-run save (also after an error or abort; consumeStream reports errors
      // to its onError and does not reject). Not tied to the SSE pipe: a delete must
      // not wait for another tab to drain its response (KD-6).
      outputCreated = true;
      void stream.consumeStream().then(
        () => run.release(),
        () => run.release(),
      );

      // version must match the `ai` major used by the frontend transport (ai@7).
      const ui = createUIMessageStream({
        execute: ({ writer }) =>
          writer.merge(
            toAISdkStream(stream, {
              from: 'agent',
              version: 'v7',
              sendReasoning: true,
              // Log the full error server-side; never leak stack traces to the client.
              onError: (error: unknown) => {
                this.logger.error(`Agent ${agentId} stream failed`, error);
                return toStreamErrorText(error);
              },
            }),
          ),
      });
      await pipeUIMessageStreamToResponse({ response: res, stream: ui });
    } finally {
      // Without a Mastra output (404, an error before the stream) the run ends here.
      if (!outputCreated) run.release();
    }
  }
}
