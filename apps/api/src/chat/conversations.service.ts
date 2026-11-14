import { Inject, Injectable } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import {
  HISTORY_PAGE_SIZE,
  THREAD_PAGE_SIZE,
  type AgentNode,
  type ConversationView,
  type InterruptResponse,
  type SendMessageResponse,
  type ThreadListResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { RuntimeError, type Runtime } from '@agent-os/runtime';
import type { Workflows } from '@agent-os/workflows';
import { AGENTS } from '../agents/agents.tokens.js';
import { RUNTIME } from '../runtime/runtime.tokens.js';
import { WORKFLOWS } from '../workflows/workflows.tokens.js';
import { CHAT_DEFINITION } from './chat-definition.js';
import { chatStatus } from './chat-status.js';
import { httpError, threadNotFound } from './chat.errors.js';
import {
  type TemplateTitles,
  templateTitles,
  toAgentTree,
  toAgentView,
  toConfirmation,
  toHistoryEntry,
  toPending,
} from './conversation-view.js';
import { type Conversation, ConversationsRepository } from './conversations.repository.js';
import { decodeThreadCursor, encodeThreadCursor, type ThreadCursor } from './thread-cursor.js';
import { TitleService } from './title.service.js';

/** The root's description: the first characters of the first message (code points, never half a pair). */
const ROOT_DESCRIPTION_LENGTH = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` can be a row id; anything else answers as a missing conversation (plan rule 11). */
export const isUuid = (id: string): boolean => UUID.test(id);

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
 * the root session of agent `chat` its first message creates. The row lock orders the first send and
 * the delete of one conversation, so a conversation never gets two roots and a delete never races a
 * send (Invariant 1). Agents are reached only through `agents.sessions` and `runtime.tasks.deleteTree`.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly titles: TitleService,
    @Inject(AGENTS) private readonly agents: Agents,
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(WORKFLOWS) private readonly workflows: Workflows,
  ) {}

  /** A page of the owner's conversations, last changed first (`THREAD_PAGE_SIZE`, `nextCursor`). */
  async list(ownerId: string, cursor?: string): Promise<ThreadListResponse> {
    const position = cursor === undefined ? undefined : this.decodeCursor(cursor);
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
   * the background, while the title is empty (DC-2).
   */
  async send(threadId: string, ownerId: string, text: string): Promise<SendMessageResponse> {
    if (!isUuid(threadId)) throw threadNotFound();
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
          definition: CHAT_DEFINITION.name,
          prompt: text,
          description: Array.from(text).slice(0, ROOT_DESCRIPTION_LENGTH).join(''),
        }));
        await this.conversations.setRoot(tx, threadId, rootId);
      } else {
        ({ messageId } = await this.agents.sessions.send({ agentId: rootId, ownerId, text }));
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

  /**
   * Flow 2, FR-16: interrupts the root's step. Without a root, or when the root is not active, a text
   * still goes as an ordinary message and the answer is `not_active` with its `messageId`.
   */
  async interrupt(threadId: string, ownerId: string, text?: string): Promise<InterruptResponse> {
    const row = await this.owned(threadId, ownerId);
    if (row.rootId !== null) {
      const outcome = await this.agents.sessions.interrupt({
        agentId: row.rootId,
        ownerId,
        ...(text === undefined ? {} : { text }),
      });
      if (outcome === 'interrupted') return { outcome };
    }
    if (text === undefined) return { outcome: 'not_active' };
    const { messageId } = await this.send(threadId, ownerId, text);
    return messageId === null ? { outcome: 'not_active' } : { outcome: 'not_active', messageId };
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
   * the root's history after `afterSeq`, its queue, the decisions of the whole tree in every status and
   * the agents under the root. A conversation without a root is `new` and empty.
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
      };
    }
    const [task, views, entries, messages, confirmations] = await Promise.all([
      this.runtime.tasks.get(rootId, ownerId),
      this.agents.sessions.list(rootId, ownerId),
      this.agents.sessions.history({ agentId: rootId, ownerId, afterSeq, limit: HISTORY_PAGE_SIZE }),
      this.runtime.inbox.listPending(rootId, ownerId),
      this.agents.sessions.confirmations(rootId, ownerId),
    ]);
    const root = views.find((view) => view.agentId === rootId);
    if (root === undefined) throw new Error(`Root ${rootId} of conversation ${threadId} has no view`);
    const templates = this.templateTitles();
    return {
      thread,
      chat: { ...chatStatus({ root, task }), rootAgentId: rootId, model: root.model },
      entries: entries.map(toHistoryEntry),
      nextAfterSeq: entries.length === HISTORY_PAGE_SIZE ? (entries.at(-1)?.seq ?? null) : null,
      pending: toPending(messages, views),
      decisions: confirmations.map((confirmation) => toConfirmation(confirmation, templates)),
      agents: toAgentTree(
        views.map((view) => toAgentView(view, templates)),
        rootId,
      ),
    };
  }

  /** The agents of the conversation under its root (AC-24.1); none while it has no root. */
  async agentsTree(threadId: string, ownerId: string): Promise<AgentNode[]> {
    const { rootId } = await this.owned(threadId, ownerId);
    if (rootId === null) return [];
    const templates = this.templateTitles();
    const views = await this.agents.sessions.list(rootId, ownerId);
    return toAgentTree(
      views.map((view) => toAgentView(view, templates)),
      rootId,
    );
  }

  /** The owner's conversation; a malformed, missing or foreign id is `THREAD_NOT_FOUND`. */
  async owned(threadId: string, ownerId: string): Promise<Conversation> {
    const row = isUuid(threadId) ? await this.conversations.get(threadId, ownerId) : undefined;
    if (row === undefined) throw threadNotFound();
    return row;
  }

  /** One read of the template catalog per view: it decides `template` of coordinators and `templateTitle` of briefs. */
  private templateTitles(): TemplateTitles {
    return templateTitles(this.workflows.templates.list());
  }

  /** A cursor of a previous page; a well-formed cursor must still name a row id. */
  private decodeCursor(cursor: string): ThreadCursor {
    const position = decodeThreadCursor(cursor);
    if (!isUuid(position.i)) throw httpError('INVALID_CURSOR');
    return position;
  }
}
