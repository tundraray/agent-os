import { Inject, Injectable } from '@nestjs/common';
import type { StorageThreadType } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';
import { toAISdkMessages } from '@mastra/ai-sdk/ui';
import {
  ThreadMessagesResponseSchema,
  type ThreadMessagesResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { THREAD_MEMORY } from './thread-memory.provider.js';
import { maskHistoryErrors, toThreadSummary } from './thread.mapper.js';
import { threadNotFound } from './threads.errors.js';

/** Input of `discardRepliesAfter`; `userMessageId` is the id of the last `user` element of `body.messages`. */
type DiscardRepliesInput = {
  threadId: string;
  userId: string;
  userMessageId: string;
};

/** Number of newest stored messages `discardRepliesAfter` looks at. */
const DISCARD_WINDOW = 20;

@Injectable()
export class ThreadsService {
  constructor(@Inject(THREAD_MEMORY) private readonly memory: Memory) {}

  /**
   * The single ownership check of the threads API: the thread must exist and
   * belong to `userId`. Missing and foreign threads raise the same 404.
   */
  async getOwnedThread(
    threadId: string,
    userId: string,
  ): Promise<StorageThreadType> {
    const thread = await this.memory.getThreadById({
      threadId,
      resourceId: userId,
    });
    if (!thread) throw threadNotFound();
    return thread;
  }

  async get(threadId: string, userId: string): Promise<ThreadSummary> {
    return toThreadSummary(await this.getOwnedThread(threadId, userId));
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
