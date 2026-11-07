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
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Mastra } from '@mastra/core/mastra';
import type { MessageListInput } from '@mastra/core/agent/message-list';
import type { MastraModelOutput } from '@mastra/core/stream';
import type { Memory } from '@mastra/memory';
import { toAISdkStream } from '@mastra/ai-sdk';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import {
  ChatMessageRefSchema,
  type ResearchDecision,
} from '@agent-os/contracts';
import { MASTRA } from '../mastra/mastra.constants.js';
import type { ReasoningEffort } from '../mastra/models.js';
import { ResearchLaunchService } from '../research-chat/research-launch.service.js';
import {
  decisionReplyMetadata,
  type ResearchTurn,
  researchTurnContext,
  researchTurnOf,
  researchTurnStreamOptions,
} from '../research-chat/research-turn.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { withFields } from '../common/log-fields.js';
import { toStreamErrorText } from '../common/stream-error-text.js';
import { THREAD_MEMORY } from '../threads/thread-memory.provider.js';
import { ThreadRunRegistry } from '../threads/thread-run-registry.js';
import { ThreadTitleService } from '../threads/thread-title.service.js';
import { threadNotFound } from '../threads/threads.errors.js';
import { ThreadsService } from '../threads/threads.service.js';
import { ChatDto } from './chat.dto.js';

/** Id prefix of research answer messages (`research-answer-<investigationId>`, design-chat-entry.md KD-4). */
const ANSWER_MESSAGE_PREFIX = 'research-answer-';

/**
 * The turn's input without the client's copies of research answers (KD-5): the server owns those messages, and the
 * model gets them from memory, so an edited copy neither reaches the model nor touches the stored answer.
 */
function withoutAnswerCopies(messages: unknown[]): MessageListInput {
  return messages.filter((message) => {
    const id =
      typeof message === 'object' && message !== null && 'id' in message
        ? message.id
        : undefined;
    return !(typeof id === 'string' && id.startsWith(ANSWER_MESSAGE_PREFIX));
  }) as MessageListInput;
}

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    @Inject(MASTRA) private readonly mastra: Mastra,
    private readonly threads: ThreadsService,
    private readonly titles: ThreadTitleService,
    private readonly runs: ThreadRunRegistry,
    private readonly config: ConfigService,
    private readonly launches: ResearchLaunchService,
    @Inject(THREAD_MEMORY) private readonly memory: Memory,
  ) {}

  /**
   * Options of a research turn (design-chat-entry.md, KD-1, KD-9): with the research mode or a card decision on the
   * last message, the turn is one forced `deepResearch` call without thinking, and its `requestContext` carries the
   * mode or the decision and the user message id — the agent takes its research model from it and the tool reads it.
   * An ordinary turn gets none.
   */
  private researchTurnOptions(turn: ResearchTurn | null) {
    if (turn === null) return {};
    return {
      ...researchTurnStreamOptions(
        this.config.get<ReasoningEffort>('REASONING_EFFORT', 'medium'),
      ),
      requestContext: researchTurnContext(turn),
    };
  }

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
    // Registered in this process before the ownership check, so a delete started
    // at any later moment either sees this run or has already marked the thread
    // (KD-6); the run's mark is written only once the thread is known to be the
    // user's, and before anything streams, so every instance's delivery loop sees
    // it (design-lifecycle.md, KD-6) and a made-up or foreign thread writes no row.
    const run = this.runs.register(threadId);
    let outputCreated = false;
    try {
      await this.threads.getOwnedThread(threadId, req.user.id);
      await run.mark();

      // AC-14.6: a regenerate resends the newest user message; its stored replies
      // are discarded before the agent writes the new one. Only a last element
      // parsed with role `user` is checked; anything else is an ordinary send.
      const turn = researchTurnOf(body.messages.at(-1));
      const lastMessage = ChatMessageRefSchema.safeParse(body.messages.at(-1));
      if (lastMessage.success && lastMessage.data.role === 'user') {
        const { repeated } = await this.threads.discardRepliesAfter({
          threadId,
          userId: req.user.id,
          userMessageId: lastMessage.data.id,
          // KD-7: the launches of the tail are discarded or set to be re-appended before it is deleted.
          beforeDelete: (tail) =>
            this.launches.discardTail(
              { threadId, resourceId: req.user.id },
              tail,
            ),
        });
        // DC-2: the next user message closes the open proposals; a decision or a regenerate does not.
        if (!repeated && turn?.kind !== 'decision') {
          await this.launches.supersedeProposals({
            threadId,
            resourceId: req.user.id,
          });
        }
      }
      const decision = turn?.kind === 'decision' ? turn.decision : null;

      // A delete of the thread started meanwhile has cancelled the run: answer before any SSE.
      if (run.signal.aborted) throw threadNotFound();

      // Express has no req.signal: abort generation when the client disconnects (closed tab).
      res.on('close', () => {
        if (!res.writableFinished) run.abort();
      });

      const stream = await agent.stream(withoutAnswerCopies(body.messages), {
        ...this.researchTurnOptions(turn),
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
      // The reply of a decision turn is marked in the store before the run is released (KD-2).
      outputCreated = true;
      void stream
        .consumeStream()
        .then(() => decision && this.markDecisionReply(stream, decision))
        .catch((error: unknown) =>
          this.logger.error(
            withFields('decision reply mark failed', {
              launchKey: decision?.launchKey,
              threadId,
            }),
            error instanceof Error ? error.stack : undefined,
          ),
        )
        .finally(() => run.release());

      // version must match the `ai` major used by the frontend transport (ai@7).
      const ui = createUIMessageStream({
        execute: ({ writer }) =>
          writer.merge(
            toAISdkStream(stream, {
              from: 'agent',
              version: 'v7',
              sendReasoning: true,
              // KD-2: the tab hides the reply of a decision turn while it streams.
              ...(decision && {
                messageMetadata: () => decisionReplyMetadata(decision),
              }),
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

  /**
   * Stores the `researchDecisionReply` mark on the reply of a decision turn (KD-2, T1.4 S4): Mastra has saved the
   * reply at the end of the run; `updateMessages` rewrites it with the mark added and its parts kept. A turn that
   * failed before a reply has nothing to mark.
   */
  private async markDecisionReply(
    stream: MastraModelOutput<unknown>,
    decision: ResearchDecision,
  ): Promise<void> {
    const { dbMessages = [] } = await stream.response;
    const replies = dbMessages.filter(
      (message) => message.role === 'assistant',
    );
    if (replies.length === 0) return;
    await this.memory.updateMessages({
      messages: replies.map(({ id, content }) => ({
        id,
        content: {
          ...content,
          metadata: { ...content.metadata, ...decisionReplyMetadata(decision) },
        },
      })),
    });
  }
}
