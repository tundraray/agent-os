import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { StorageThreadType } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';
import { toAISdkMessages } from '@mastra/ai-sdk/ui';
import {
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
import { THREAD_MEMORY } from './thread-memory.provider.js';
import { ThreadRunRegistry } from './thread-run-registry.js';
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
};

/** Number of newest stored messages `discardRepliesAfter` looks at. */
const DISCARD_WINDOW = 20;

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
   * `PostgresStore.deleteThread`). Foreign, missing and already deleted
   * threads raise the ownership 404 before any run is touched. The thread's
   * runs are cancelled and awaited first (KD-6): Mastra's end-of-run save
   * would otherwise re-create the deleted thread (AC-16.1 (b)). The wait runs
   * outside the lock; the delete itself runs under the thread's lock.
   */
  async delete(threadId: string, userId: string): Promise<void> {
    await this.getOwnedThread(threadId, userId);
    await this.runs.cancelRunsThen(threadId, () =>
      this.lock.run(threadId, () => this.memory.deleteThread(threadId)),
    );
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
   * "Discard the tail" (AC-14.6): when the request resends the newest stored
   * user message, deletes the assistant replies stored after it, so the
   * regenerated reply is not appended to them. Deletes only ids returned by
   * `recall` of this owner's thread, never ids from the request body. Errors of
   * `recall`/`deleteMessages` propagate (500 before the stream starts).
   * Precondition: `getOwnedThread(threadId, userId)` has passed.
   */
  async discardRepliesAfter(input: DiscardRepliesInput): Promise<void> {
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
      (message) => message.role === 'user',
    );
    if (newestUserIndex === -1) return;
    if (messages[newestUserIndex].id !== input.userMessageId) return;
    const tail = messages.slice(newestUserIndex + 1);
    if (tail.length === 0) return;
    if (!tail.every((message) => message.role === 'assistant')) return;
    await this.memory.deleteMessages(tail.map((message) => message.id));
  }
}
