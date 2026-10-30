import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { MastraDBMessage } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';
import { THREAD_MEMORY } from './thread-memory.provider.js';
import {
  buildTitlePrompt,
  GeneratedTitleSchema,
  normalizeGeneratedTitle,
  THREAD_TITLE_AGENT,
} from './thread-title.agent.js';
import { ThreadWriteLock } from './thread-write-lock.js';

/** Token of the generation timeout in ms; `ThreadsModule` provides 8 000. */
export const THREAD_TITLE_TIMEOUT_MS = Symbol('THREAD_TITLE_TIMEOUT_MS');

/** At most this many characters of the first user message reach the title model. */
const TITLE_SOURCE_MAX_LENGTH = 2_000;

/**
 * The part of a `generate` result the service reads; Mastra's `FullOutput` satisfies it.
 * `object` is parsed with `GeneratedTitleSchema`; the free text and reasoning are never read.
 */
export interface ThreadTitleResult {
  object: unknown;
  totalUsage: { inputTokens?: number; outputTokens?: number };
}

/** The part of the title `Agent` the service needs; the Mastra `Agent` satisfies it. */
export interface ThreadTitleGenerator {
  generate(
    message: string,
    options: { abortSignal: AbortSignal },
  ): Promise<ThreadTitleResult>;
}

type ScheduleInput = { threadId: string; resourceId: string };

/** Raised when the structured answer has no usable title; logged as `reason=EmptyTitle`. */
class EmptyTitleError extends Error {
  override name = 'EmptyTitle';
}

/**
 * Background auto-title of a thread (FR-17): names an untitled thread after its
 * first stored user message. Writes only into an empty title, under the
 * thread's `ThreadWriteLock`, so a manual rename always wins (AC-17.2). Every
 * failure is swallowed and logged; the title stays empty and the next
 * `schedule` of the thread tries again (AC-17.3).
 */
@Injectable()
export class ThreadTitleService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ThreadTitleService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(THREAD_MEMORY) private readonly memory: Memory,
    @Inject(THREAD_TITLE_AGENT) private readonly agent: ThreadTitleGenerator,
    private readonly lock: ThreadWriteLock,
    @Inject(THREAD_TITLE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  /** Starts the title task in the background; never throws and never rejects. */
  schedule(input: ScheduleInput): void {
    const task = this.generateTitle(input).finally(() => {
      this.pending.delete(task);
    });
    this.pending.add(task);
  }

  /** Lets unfinished title tasks settle; each one is bounded by the timeout. */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  private async generateTitle({
    threadId,
    resourceId,
  }: ScheduleInput): Promise<void> {
    let signal: AbortSignal | undefined;
    try {
      if (!(await this.isUntitled(threadId, resourceId))) {
        this.logger.debug(`Title skipped thread=${threadId}`);
        return;
      }
      const userText = await this.readFirstUserText(threadId, resourceId);
      if (userText === '') {
        this.logger.debug(`Title source missing thread=${threadId}`);
        return;
      }
      signal = AbortSignal.timeout(this.timeoutMs);
      const result = await this.agent.generate(buildTitlePrompt(userText), {
        abortSignal: signal,
      });
      this.logger.log(
        `usage agent=thread-title thread=${threadId} ` +
          `input=${result.totalUsage.inputTokens ?? 0} output=${result.totalUsage.outputTokens ?? 0}`,
      );
      // The installed Mastra resolves an aborted generate instead of rejecting it.
      signal.throwIfAborted();
      const answer = GeneratedTitleSchema.safeParse(result.object);
      if (!answer.success) throw new EmptyTitleError();
      const title = normalizeGeneratedTitle(answer.data.title);
      if (title === '') throw new EmptyTitleError();
      await this.writeIfUntitled({ threadId, resourceId, title });
    } catch (error) {
      this.logFailure(threadId, error, signal?.aborted === true);
    }
  }

  private async isUntitled(
    threadId: string,
    resourceId: string,
  ): Promise<boolean> {
    const thread = await this.memory.getThreadById({ threadId, resourceId });
    return thread !== null && thread.title === '';
  }

  /** Text of the first stored message when it is a user message, else `''`. */
  private async readFirstUserText(
    threadId: string,
    resourceId: string,
  ): Promise<string> {
    const {
      messages: [first],
    } = await this.memory.recall({
      threadId,
      resourceId,
      perPage: 1,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'ASC' },
      includeTotal: false,
    });
    if (first === undefined || first.role !== 'user') return '';
    return extractUserText(first);
  }

  /** Re-checks the title under the lock: a rename that landed meanwhile wins. */
  private async writeIfUntitled(
    input: ScheduleInput & { title: string },
  ): Promise<void> {
    await this.lock.run(input.threadId, async () => {
      if (!(await this.isUntitled(input.threadId, input.resourceId))) return;
      await this.memory.updateThread({
        id: input.threadId,
        title: input.title,
      });
    });
  }

  /** Logs only the thread id and error metadata: never `error.message` or texts (PII). */
  private logFailure(
    threadId: string,
    error: unknown,
    timedOut: boolean,
  ): void {
    const reason = timedOut ? 'TimeoutError' : errorName(error);
    const statusCode = errorField(error, 'statusCode');
    const code = errorField(error, 'code');
    this.logger.warn(
      `Title generation failed thread=${threadId} reason=${reason}` +
        (statusCode === undefined ? '' : ` statusCode=${statusCode}`) +
        (code === undefined ? '' : ` code=${code}`),
    );
  }
}

/** Concatenated text parts, trimmed, cut to 2 000 code points (a surrogate pair is never split). */
function extractUserText(message: MastraDBMessage): string {
  const text = message.content.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim();
  return Array.from(text).slice(0, TITLE_SOURCE_MAX_LENGTH).join('');
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * A numeric or string `statusCode` / `code` of a model provider error, if present. A
 * `DOMException` (the timeout reason) is skipped: its numeric `code` is a legacy constant.
 */
function errorField(
  error: unknown,
  field: 'statusCode' | 'code',
): string | number | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    error instanceof DOMException ||
    !(field in error)
  ) {
    return undefined;
  }
  const value: unknown = Reflect.get(error, field);
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
}
