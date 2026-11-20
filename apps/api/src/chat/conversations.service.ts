import { Inject, Injectable } from '@nestjs/common';
import { inRootLaunchSet, type Agents } from '@agent-os/agents';
import {
  HISTORY_PAGE_SIZE,
  THREAD_PAGE_SIZE,
  type AgentNode,
  type ChipRecord,
  type ConversationView,
  type InterruptResponse,
  type SendMessageResponse,
  type ThreadListResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { RuntimeError, type Runtime } from '@agent-os/runtime';
import { AGENTS } from '../agents/agents.tokens.js';
import { isUuid } from '../common/is-uuid.js';
import { libraryError } from '../library/library.errors.js';
import { LibraryService } from '../library/library.service.js';
import { RUNTIME } from '../runtime/runtime.tokens.js';
import { chatStatus } from './chat-status.js';
import { httpError, threadNotFound } from './chat.errors.js';
import {
  nextAfterSeqOf,
  toAgentTree,
  toConfirmation,
  toHistoryEntry,
  toPending,
} from './conversation-view.js';
import { type Conversation, ConversationsRepository } from './conversations.repository.js';
import { DraftsService } from './drafts.service.js';
import { decodeThreadCursor, encodeThreadCursor, type ThreadCursor } from './thread-cursor.js';
import { TitleService } from './title.service.js';

/** The root's description: the first characters of the first message (code points, never half a pair). */
const ROOT_DESCRIPTION_LENGTH = 80;

/** A cursor of a previous page; a well-formed cursor must still name a row id (`INVALID_CURSOR`). */
export function decodeRowCursor(cursor: string): ThreadCursor {
  const position = decodeThreadCursor(cursor);
  if (!isUuid(position.i)) throw httpError('INVALID_CURSOR');
  return position;
}

/** A row as the API shows it: an empty title is `null` («Новая беседа»). */
export function toThreadSummary(row: Conversation): ThreadSummary {
  return {
    id: row.id,
    title: row.title === '' ? null : row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Conversations over agents (design-chat.md, KD-1, Flows 1, 2, 6): a row of `chat_conversations` and
 * the root session its first message starts from the library record `chat` (design-runtime.md, KD-7).
 * The row lock orders the first send and the delete of one conversation, so a conversation never gets
 * two roots and a delete never races a send (Invariant 1). Agents are reached only through
 * `agents.sessions` and `runtime.tasks.deleteTree`; a message's record chip is checked in the library.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly titles: TitleService,
    @Inject(AGENTS) private readonly agents: Agents,
    @Inject(RUNTIME) private readonly runtime: Runtime,
    private readonly library: LibraryService,
    private readonly drafts: DraftsService,
  ) {}

  /** A page of the owner's conversations, last changed first (`THREAD_PAGE_SIZE`, `nextCursor`). */
  async list(ownerId: string, cursor?: string): Promise<ThreadListResponse> {
    const position = cursor === undefined ? undefined : decodeRowCursor(cursor);
    const rows = await this.conversations.page(ownerId, position, THREAD_PAGE_SIZE);
    const page = rows.slice(0, THREAD_PAGE_SIZE);
    const last = page.at(-1);
    return {
      threads: page.map(toThreadSummary),
      nextCursor: rows.length > THREAD_PAGE_SIZE && last ? encodeThreadCursor(last) : null,
    };
  }

  async create(ownerId: string): Promise<ThreadSummary> {
    return toThreadSummary(await this.conversations.create(ownerId));
  }

  async get(threadId: string, ownerId: string): Promise<ThreadSummary> {
    return toThreadSummary(await this.owned(threadId, ownerId));
  }

  async rename(threadId: string, ownerId: string, title: string): Promise<ThreadSummary> {
    const row = isUuid(threadId)
      ? await this.conversations.rename(threadId, ownerId, title)
      : undefined;
    if (row === undefined) throw threadNotFound();
    return toThreadSummary(row);
  }

  /**
   * DC-1: the first message creates the root with the text as its task (`messageId` null), any later
   * one goes into the root's queue. Both under the row lock; the title starts after the commit, in
   * the background, while the title is empty (DC-2). A record chip is checked before the transaction
   * (KD-4, DC-6), so a refused chip leaves the queue untouched. A root the start procedure refuses is
   * `START_REFUSED` from `agents` and rolls the send back.
   */
  async send(
    threadId: string,
    ownerId: string,
    text: string,
    recordId?: string,
  ): Promise<SendMessageResponse> {
    if (!isUuid(threadId)) throw threadNotFound();
    const record = recordId === undefined ? undefined : await this.chipOf(ownerId, recordId);
    const chip = record === undefined ? {} : { record };
    const sent = await this.conversations.transaction(async (tx) => {
      const row = await this.conversations.lockForUpdate(tx, threadId, ownerId);
      if (row === undefined) throw threadNotFound();
      let rootId = row.rootId;
      let messageId: string | null = null;
      if (rootId === null) {
        // A process dying between `start` and `setRoot` leaves a root no conversation sees; the next
        // send finds no root and creates a new one (Flow 1, Failure handling).
        ({ agentId: rootId } = await this.agents.sessions.start({
          ownerId,
          prompt: text,
          description: Array.from(text).slice(0, ROOT_DESCRIPTION_LENGTH).join(''),
          ...chip,
        }));
        await this.conversations.setRoot(tx, threadId, rootId);
      } else {
        ({ messageId } = await this.agents.sessions.send({ agentId: rootId, ownerId, text, ...chip }));
      }
      await this.conversations.touch(tx, threadId);
      return { rootId, messageId, untitled: row.title === '', created: row.rootId === null };
    });
    if (sent.untitled) {
      this.titles.ensure({
        threadId,
        ownerId,
        rootId: sent.rootId,
        ...(sent.created ? { firstText: text } : {}),
      });
    }
    return { messageId: sent.messageId };
  }

  /** Flow 2, FR-16: interrupts the root's step; `not_active` without a root or when the root is not active. */
  async interrupt(threadId: string, ownerId: string): Promise<InterruptResponse> {
    const row = await this.owned(threadId, ownerId);
    if (row.rootId === null) return { outcome: 'not_active' };
    return { outcome: await this.agents.sessions.interrupt({ agentId: row.rootId, ownerId }) };
  }

  /**
   * Flow 6: under the row lock, the root's tree is stopped and deleted, then the row. A tree already
   * gone (`TASK_NOT_FOUND`: an earlier attempt failed after `deleteTree`) does not stop the delete.
   */
  async delete(threadId: string, ownerId: string): Promise<void> {
    if (!isUuid(threadId)) throw threadNotFound();
    await this.conversations.transaction(async (tx) => {
      const row = await this.conversations.lockForUpdate(tx, threadId, ownerId);
      if (row === undefined) throw threadNotFound();
      if (row.rootId !== null) {
        try {
          await this.runtime.tasks.deleteTree(row.rootId, ownerId);
        } catch (error) {
          if (!(error instanceof RuntimeError && error.code === 'TASK_NOT_FOUND')) throw error;
        }
      }
      await this.conversations.delete(tx, threadId);
    });
  }

  /**
   * The conversation as the web reads it (design-chat.md, ConversationView): the chat status, a page of
   * the root's history after `afterSeq`, its queue, the decisions of the whole tree in every status, the
   * agents under the root and every record draft (design-runtime.md, KD-6). A conversation without a
   * root is `new` and empty: only the root's `draft_record` writes a draft.
   */
  async view(threadId: string, ownerId: string, afterSeq: number): Promise<ConversationView> {
    const row = await this.owned(threadId, ownerId);
    const thread = toThreadSummary(row);
    const rootId = row.rootId;
    if (rootId === null) {
      return {
        thread,
        chat: { ...chatStatus({ root: null, task: null }), rootAgentId: null, model: null },
        entries: [],
        nextAfterSeq: null,
        pending: [],
        decisions: [],
        agents: [],
        drafts: [],
      };
    }
    const [task, views, entries, messages, confirmations, drafts] = await Promise.all([
      this.runtime.tasks.get(rootId, ownerId),
      this.agents.sessions.list(rootId, ownerId),
      this.agents.sessions.history({ agentId: rootId, ownerId, afterSeq, limit: HISTORY_PAGE_SIZE }),
      this.runtime.inbox.listPending(rootId, ownerId),
      this.agents.sessions.confirmations(rootId, ownerId),
      this.drafts.list(threadId),
    ]);
    const root = views.find((view) => view.agentId === rootId);
    if (root === undefined) throw new Error(`Root ${rootId} of conversation ${threadId} has no view`);
    return {
      thread,
      chat: { ...chatStatus({ root, task }), rootAgentId: rootId, model: root.model },
      entries: entries.map(toHistoryEntry),
      nextAfterSeq: nextAfterSeqOf(entries),
      pending: toPending(messages, views),
      decisions: confirmations.map((confirmation) => toConfirmation(confirmation, views)),
      agents: toAgentTree(views, rootId),
      drafts,
    };
  }

  /** The agents of the conversation under its root (AC-24.1); none while it has no root. */
  async agentsTree(threadId: string, ownerId: string): Promise<AgentNode[]> {
    const { rootId } = await this.owned(threadId, ownerId);
    if (rootId === null) return [];
    const views = await this.agents.sessions.list(rootId, ownerId);
    return toAgentTree(views, rootId);
  }

  /**
   * The chip of a message: a record the employee's main chat may start (the one launch-set rule of
   * `agents`). An invisible, another's personal, a disabled, a missing record and an id that is not a
   * UUID (`resolve` answers it without a query) answer alike: 404 RECORD_NOT_FOUND of the library.
   */
  private async chipOf(ownerId: string, recordId: string): Promise<ChipRecord> {
    const resolved = await this.library.resolve(ownerId, recordId);
    if (resolved === null || !inRootLaunchSet(resolved)) throw libraryError('RECORD_NOT_FOUND');
    return { id: resolved.id, kind: resolved.kind, name: resolved.name };
  }

  /** The owner's conversation; a malformed, missing or foreign id is `THREAD_NOT_FOUND`. */
  async owned(threadId: string, ownerId: string): Promise<Conversation> {
    const row = isUuid(threadId) ? await this.conversations.get(threadId, ownerId) : undefined;
    if (row === undefined) throw threadNotFound();
    return row;
  }
}
