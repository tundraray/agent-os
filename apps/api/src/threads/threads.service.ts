import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';
import { toAISdkMessages } from '@mastra/ai-sdk/ui';
import {
  RESEARCH_METADATA_KEYS,
  THREAD_PAGE_SIZE,
  ThreadMessagesResponseSchema,
  type ThreadListResponse,
  type ThreadMessagesResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import {
  decodeThreadCursor,
  selectThreadPage,
  sortThreadsForList,
} from './thread-cursor.js';
import { ThreadDeletionHooks } from './thread-deletion-hooks.js';
import { THREAD_MEMORY } from './thread-memory.provider.js';
import {
  THREAD_RUN_SETTLE_TIMEOUT_MS,
  ThreadRunRegistry,
} from './thread-run-registry.js';
import { ThreadWriteLock } from './thread-write-lock.js';
import { maskHistoryErrors, toThreadSummary } from './thread.mapper.js';
import { isMastraUserError, threadNotFound } from './threads.errors.js';

/** Input of `rename`; `title` is already trimmed and 1..200 characters (pipe). */
type RenameThreadInput = {
  threadId: string;
  userId: string;
  title: string;
};

/** Input of `discardRepliesAfter`; `userMessageId` is the id of the last `user` element of `body.messages`. */
type DiscardRepliesInput = {
  threadId: string;
  userId: string;
  userMessageId: string;
  /**
   * Called only when the tail will be deleted, with the tail as `recall`
   * returned it (oldest first), outside the thread's lock and outside the
   * delete. Its exception cancels the delete and propagates; it may run again
   * on the next regenerate when `deleteMessages` fails after it (KD-8).
   */
  beforeDelete?: (tail: MastraDBMessage[]) => Promise<void>;
};

/** Result of `discardRepliesAfter`: whether `userMessageId` is the newest stored user message, deleted or not. */
type DiscardRepliesResult = { repeated: boolean };

/** Number of newest stored messages `discardRepliesAfter` looks at. */
const DISCARD_WINDOW = 20;

/** A hidden user message of a launch card decision (design-chat-entry.md, KD-2). */
const isResearchDecision = (message: MastraDBMessage): boolean =>
  message.content.metadata?.[RESEARCH_METADATA_KEYS.researchDecision] !==
  undefined;

/** A tail message the discard may delete: any assistant message, or a decision message (KD-8). */
const isDiscardable = (message: MastraDBMessage): boolean =>
  message.role === 'assistant' ||
  (message.role === 'user' && isResearchDecision(message));

/**
 * Fails fast on an empty owner id. `PostgresStore.listThreads` skips the
 * `resourceId` filter for a falsy value, so an empty id would read every
 * user's threads. A plain Error (not an HttpException): this is a server
 * defect, answered with 500.
 */
const assertUserId = (userId: string): void => {
  if (!userId) throw new Error('ThreadsService: userId must not be empty');
};

@Injectable()
export class ThreadsService {
  constructor(
    @Inject(THREAD_MEMORY) private readonly memory: Memory,
    private readonly lock: ThreadWriteLock,
    private readonly runs: ThreadRunRegistry,
    private readonly deletionHooks: ThreadDeletionHooks,
    @Inject(THREAD_RUN_SETTLE_TIMEOUT_MS)
    private readonly settleTimeoutMs: number,
  ) {}

  /**
   * The single ownership check of the threads API: the thread must exist and
   * belong to `userId`. Missing and foreign threads raise the same 404.
   */
  async getOwnedThread(
    threadId: string,
    userId: string,
  ): Promise<StorageThreadType> {
    assertUserId(userId);
    const thread = await this.memory.getThreadById({
      threadId,
      resourceId: userId,
    });
    if (!thread) throw threadNotFound();
    return thread;
  }

  /**
   * Runs `fn` under the thread's `ThreadWriteLock` after the ownership check
   * made under the same lock, so a write tied to the thread (an investigation
   * of `research`) is serialised with the thread's delete: it either sees the
   * thread gone (404) or lands before the delete's purge. Missing and foreign
   * threads raise the ownership 404 and `fn` is not called.
   */
  async withOwnedThread<T>(
    threadId: string,
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.lock.run(threadId, async () => {
      await this.getOwnedThread(threadId, userId);
      return fn();
    });
  }

  /**
   * One page of the user's threads, newest `updatedAt` first (ties: `id`
   * DESC). Pages by an opaque keyset cursor over the full list, not by offset,
   * so deletes and raises during a traversal cause no duplicates (AC-13.2a).
   * An invalid cursor is rejected (400) before storage is read.
   */
  async list(userId: string, cursor?: string): Promise<ThreadListResponse> {
    assertUserId(userId);
    const position =
      cursor === undefined ? undefined : decodeThreadCursor(cursor);
    const { threads } = await this.memory.listThreads({
      filter: { resourceId: userId },
      perPage: false,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    });
    const page = selectThreadPage({
      sorted: sortThreadsForList(threads),
      cursor: position,
      size: THREAD_PAGE_SIZE,
    });
    return {
      threads: page.threads.map(toThreadSummary),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * The only way a thread is created (KD-4): the id is a server UUID, never a
   * client value, so a deleted id is never reused. Stored with title `''`.
   */
  async create(userId: string): Promise<ThreadSummary> {
    const thread = await this.memory.createThread({
      resourceId: userId,
      threadId: randomUUID(),
    });
    return toThreadSummary(thread);
  }

  async get(threadId: string, userId: string): Promise<ThreadSummary> {
    return toThreadSummary(await this.getOwnedThread(threadId, userId));
  }

  /**
   * Renames an own thread under the thread's `ThreadWriteLock`, so the write is
   * serialised with the auto-title write of the same thread (AC-17.2).
   * `updateThread` also sets `updatedAt = now()`: the thread rises to the top of
   * the list. A thread deleted between the ownership check and the write
   * answers the ownership 404; any other storage failure keeps its own error.
   */
  async rename({
    threadId,
    userId,
    title,
  }: RenameThreadInput): Promise<ThreadSummary> {
    return this.lock.run(threadId, async () => {
      await this.getOwnedThread(threadId, userId);
      try {
        return toThreadSummary(
          await this.memory.updateThread({ id: threadId, title }),
        );
      } catch (error) {
        if (isMastraUserError(error)) throw threadNotFound();
        // A failing re-read must not replace the original error.
        const stillExists = await this.memory
          .getThreadById({ threadId, resourceId: userId })
          .catch(() => undefined);
        if (stillExists === null) throw threadNotFound();
        throw error;
      }
    });
  }

  /**
   * Deletes an own thread with its messages (one PG transaction in
   * `PostgresStore.deleteThread`) and the data of the deletion hooks, in two
   * phases (KD-5). Foreign, missing and already deleted threads raise the
   * ownership 404 before anything is touched. Phase one, outside the lock: the
   * hooks stop the thread's work, the thread's runs are cancelled (KD-6:
   * Mastra's end-of-run save would otherwise re-create the deleted thread,
   * AC-16.1 (b)), and both are awaited within one settle window. Phase two,
   * under the thread's lock: the hooks purge, then the thread is deleted. A
   * hook error answers 500 and keeps the thread (AC-23.5).
   */
  async delete(threadId: string, userId: string): Promise<void> {
    await this.getOwnedThread(threadId, userId);
    const ref = { threadId, resourceId: userId };
    const window = AbortSignal.timeout(this.settleTimeoutMs);
    const { settled } = await this.deletionHooks.stopAll(ref, window);
    await this.runs.cancelRunsThen(threadId, async () => {
      await settled;
      await this.lock.run(threadId, async () => {
        await this.deletionHooks.purgeAll(ref);
        await this.memory.deleteThread(threadId);
      });
    });
  }

  /** Every stored message of the thread (no `lastMessages` cap), oldest first, as AI SDK v7 UIMessages. */
  async listMessages(
    threadId: string,
    userId: string,
  ): Promise<ThreadMessagesResponse> {
    await this.getOwnedThread(threadId, userId);
    const { messages } = await this.memory.recall({
      threadId,
      resourceId: userId,
      perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    // V7UIMessage has no index signature, so it is not assignable to the loose
    // contract type; narrow at the boundary with the schema instead of a cast.
    const history = ThreadMessagesResponseSchema.parse({
      messages: toAISdkMessages(messages, { version: 'v7' }),
    });
    return { messages: maskHistoryErrors(history.messages) };
  }

  /**
   * "Discard the tail" (AC-14.6, KD-8): when the request resends the newest
   * stored user message without `researchDecision`, deletes everything stored
   * after it — assistant replies and hidden decision messages — so the
   * regenerated reply is not appended to them. Returns `repeated`: whether the
   * request resends that message, whether or not a tail was deleted. Deletes
   * only ids returned by `recall` of this owner's thread, never ids from the
   * request body. Errors of `recall`/`beforeDelete`/`deleteMessages` propagate
   * (500 before the stream starts). Precondition:
   * `getOwnedThread(threadId, userId)` has passed.
   */
  async discardRepliesAfter(
    input: DiscardRepliesInput,
  ): Promise<DiscardRepliesResult> {
    const { messages } = await this.memory.recall({
      threadId: input.threadId,
      resourceId: input.userId,
      perPage: DISCARD_WINDOW,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
      includeTotal: false,
    });
    // The installed Mastra returns the newest page ordered oldest → newest.
    const newestUserIndex = messages.findLastIndex(
      (message) => message.role === 'user' && !isResearchDecision(message),
    );
    const repeated =
      newestUserIndex !== -1 &&
      messages[newestUserIndex].id === input.userMessageId;
    if (!repeated) return { repeated };
    const tail = messages.slice(newestUserIndex + 1);
    if (tail.length === 0 || !tail.every(isDiscardable)) return { repeated };
    await input.beforeDelete?.(tail);
    await this.memory.deleteMessages(tail.map((message) => message.id));
    return { repeated };
  }
}
