import { Inject, Injectable } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { AGENTS } from '../agents/agents.tokens.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { ConversationsRepository } from './conversations.repository.js';
import {
  buildTitlePrompt,
  normalizeGeneratedTitle,
  TITLE_SYSTEM_PROMPT,
} from './title-rules.js';

/** Output budget of the title call: a title is at most 80 characters. */
const TITLE_MAX_OUTPUT_TOKENS = 64;
/** The title call is abandoned after this; the next send tries again (DC-2). */
const TITLE_TIMEOUT_MS = 8_000;

export type EnsureTitleRequest = {
  readonly threadId: string;
  readonly ownerId: string;
  readonly rootId: string;
  /** The text of the first message when this send created the root; otherwise the root's task is read. */
  readonly firstText?: string;
};

/**
 * The automatic title of a conversation (design-chat.md, DC-2, KD-6): one `agents.completeText` call
 * over the first message, the title rules, and a write only into an empty title. It runs in the
 * background of a send whose conversation has no title yet, at most once at a time per conversation
 * in this process; a failure or an empty answer leaves the title empty, and the next send retries.
 */
@Injectable()
export class TitleService {
  /** Conversations whose title is being generated in this process. */
  private readonly generating = new Set<string>();
  private readonly logger: Logger;

  constructor(
    @Inject(AGENTS) private readonly agents: Agents,
    private readonly conversations: ConversationsRepository,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.title' });
  }

  /** Starts the generation unless one runs for this conversation; never throws, never waits for it. */
  ensure(request: EnsureTitleRequest): void {
    if (this.generating.has(request.threadId)) return;
    this.generating.add(request.threadId);
    void this.generate(request).finally(() => this.generating.delete(request.threadId));
  }

  private async generate({ threadId, ownerId, rootId, firstText }: EnsureTitleRequest): Promise<void> {
    const startedAt = Date.now();
    try {
      const source = firstText ?? (await this.firstTask(rootId, ownerId));
      if (source === undefined) {
        this.logger.warn('thread title not generated', {
          threadId,
          error: 'the root has no task entry',
        });
        return;
      }
      const answer = await this.agents.completeText({
        ownerId,
        system: TITLE_SYSTEM_PROMPT,
        prompt: buildTitlePrompt(source),
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      });
      const title = normalizeGeneratedTitle(answer, source);
      if (title === '') {
        this.logger.warn('thread title not generated', {
          threadId,
          error: 'the model answered no usable title',
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const written = await this.conversations.setTitleIfEmpty(threadId, title);
      this.logger.info('thread title generated', {
        threadId,
        ownerId,
        written,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.logger.warn('thread title not generated', {
        threadId,
        error,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /** The text of the root's first entry, its task (Notes 5(в)): the title follows the first message. */
  private async firstTask(rootId: string, ownerId: string): Promise<string | undefined> {
    const [first] = await this.agents.sessions.history({ agentId: rootId, ownerId, limit: 1 });
    return first?.kind === 'task' ? first.content.text : undefined;
  }
}
