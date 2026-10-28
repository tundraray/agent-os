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
import { MASTRA } from '../mastra/mastra.constants.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { ChatDto } from './chat.dto.js';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(@Inject(MASTRA) private readonly mastra: Mastra) {}

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

    // Express has no req.signal: abort generation when the client disconnects (closed tab).
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    const stream = await agent.stream(body.messages as MessageListInput, {
      memory: { thread: threadId, resource: req.user.id },
      abortSignal: abort.signal,
      onFinish: ({ totalUsage: u }) => {
        this.logger.log(
          `usage agent=${agentId} thread=${threadId} input=${u.inputTokens ?? 0} ` +
            `cacheRead=${u.cachedInputTokens ?? 0} cacheWrite=${u.cacheCreationInputTokens ?? 0} ` +
            `output=${u.outputTokens ?? 0}`,
        );
      },
    });

    // version must match the `ai` major used by the frontend transport (ai@7).
    const ui = createUIMessageStream({
      execute: ({ writer }) =>
        writer.merge(
          toAISdkStream(stream, {
            from: 'agent',
            version: 'v7',
            sendReasoning: true,
            // Log the full error server-side; never leak stack traces to the client.
            onError: (error) => {
              this.logger.error(`Agent ${agentId} stream failed`, error as Error);
              return error instanceof Error && 'statusCode' in error ? `Model provider error (${String(error.statusCode)})` : 'Agent error';
            },
          }),
        ),
    });
    await pipeUIMessageStreamToResponse({ response: res, stream: ui });
  }
}
