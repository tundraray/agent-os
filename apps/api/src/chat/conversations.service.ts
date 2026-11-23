import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  inRootLaunchSet,
  type AgentHistoryEntry,
  type RootSession,
  ViewOperations,
  ControlOperations,
  StartOperations,
} from '@agent-os/agents';
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
import { Inbox, RuntimeError, TaskControl } from '@agent-os/runtime';
import { isUuid } from '../common/is-uuid';
import { libraryError } from '../library/library.errors';
import { LibraryService } from '../library/library.service';
import { chatStatus } from './chat-status';
import { threadNotFound } from './chat.errors';
import {
  focusOf,
  nextAfterSeqOf,
  toAgentTree,
  toConfirmation,
  toHistoryEntry,
  toPending,
} from './conversation-view';
import { encodeThreadCursor } from './thread-cursor';
import { decodeRowCursor, toThreadSummary } from './thread-summary';
import { TitleService } from './title.service';

/** The root's description: the first characters of the first message (code points, never half a pair). */
const ROOT_DESCRIPTION_LENGTH = 80;

/**
 * Conversations over agents (design-chat.md, Flows 1, 2, 6): a conversation is the root session of the
 * library record `chat` (design-runtime.md, KD-7), and its id is the root's. It appears with its first
 * message — `create` only hands out an id. Agents are reached only through the operations of the agents package; a
 * message's record chip is checked in the library. An id without a live root session of the employee
 * — never used, deleted, or another employee's — is `THREAD_NOT_FOUND` on every route; only a never
 * used id starts a conversation with the first send. A deleted conversation answers as a missing one
 * everywhere, the send included: its rows stay and keep its id taken.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly titles: TitleService,
    @Inject(ViewOperations) private readonly views: ViewOperations,
    @Inject(ControlOperations) private readonly control: ControlOperations,
    @Inject(StartOperations) private readonly starts: StartOperations,
    @Inject(TaskControl) private readonly tasks: TaskControl,
    @Inject(Inbox) private readonly inbox: Inbox,
    private readonly library: LibraryService,
  ) {}

  /** A page of the owner's conversations, last changed first (`THREAD_PAGE_SIZE`, `nextCursor`). */
  async list(ownerId: string, cursor?: string): Promise<ThreadListResponse> {
    const position = cursor === undefined ? undefined : decodeRowCursor(cursor);
    const roots = await this.views.roots({
      ownerId,
      limit: THREAD_PAGE_SIZE + 1,
      ...(position === undefined
        ? {}
        : { after: { updatedAt: new Date(position.u), rootId: position.i } }),
    });
    const page = roots.slice(0, THREAD_PAGE_SIZE);
    const last = page.at(-1);
    return {
      threads: page.map(toThreadSummary),
      nextCursor:
        roots.length > THREAD_PAGE_SIZE && last
          ? encodeThreadCursor({ updatedAt: last.updatedAt, id: last.rootId })
          : null,
    };
  }

  /** The id of a new conversation. Nothing is written: the conversation appears with its first message. */
  create(): ThreadSummary {
    const now = new Date().toISOString();
    return { id: randomUUID(), title: null, createdAt: now, updatedAt: now };
  }

  async get(threadId: string, ownerId: string): Promise<ThreadSummary> {
    return toThreadSummary(await this.owned(threadId, ownerId));
  }

  async rename(
    threadId: string,
    ownerId: string,
    title: string,
  ): Promise<ThreadSummary> {
    const root = isUuid(threadId)
      ? await this.control.renameRoot(threadId, ownerId, title)
      : undefined;
    if (root === undefined) throw threadNotFound();
    return toThreadSummary(root);
  }

  /**
   * DC-1: the first message creates the root, with the conversation's id and the text as its task
   * (`messageId` null); any later one goes into the root's queue and moves the conversation up. The
   * title starts in the background while it is empty (DC-2). A record chip is checked first (KD-4,
   * DC-6), so a refused chip leaves the queue untouched. A root the start procedure refuses is
   * `START_REFUSED` from `agents`, and no conversation appears. The id of a deleted conversation is
   * taken by its rows: `start` gets `TASK_EXISTS` and `owned()` answers 404, for its owner and anyone
   * else alike. A send to a conversation deleted meanwhile is `AGENT_NOT_FOUND` of `agents`: the delete
   * and the send take turns on the root task's lock.
   */
  async send(
    threadId: string,
    ownerId: string,
    text: string,
    recordId?: string,
  ): Promise<SendMessageResponse> {
    if (!isUuid(threadId)) throw threadNotFound();
    const record =
      recordId === undefined ? undefined : await this.chipOf(ownerId, recordId);
    const chip = record === undefined ? {} : { record };
    const existing = await this.views.root(threadId, ownerId);
    const created =
      existing === undefined &&
      (await this.start(threadId, ownerId, text, chip));
    let messageId: string | null = null;
    let untitled = true;
    if (!created) {
      // The id is taken: by the employee's root (`start` lost to a simultaneous first send), or by a
      // task that is not their conversation, another employee's included.
      const root = existing ?? (await this.owned(threadId, ownerId));
      ({ messageId } = await this.control.send({
        agentId: threadId,
        ownerId,
        text,
        ...chip,
      }));
      await this.control.touchRoot(threadId, ownerId);
      untitled = root.title === '';
    }
    if (untitled)
      this.titles.ensure({
        threadId,
        ownerId,
        ...(created ? { firstText: text } : {}),
      });
    return { messageId };
  }

  /** Flow 2, FR-16: interrupts the root's step; `not_active` when the root is not active. */
  async interrupt(
    threadId: string,
    ownerId: string,
  ): Promise<InterruptResponse> {
    await this.owned(threadId, ownerId);
    return {
      outcome: await this.control.interrupt({ agentId: threadId, ownerId }),
    };
  }

  /**
   * Flow 6: the root's tree is stopped and marked deleted together with the root session, in one
   * transaction; the rows stay. A conversation deleted meanwhile is `AGENT_NOT_FOUND` of `agents`.
   */
  async delete(threadId: string, ownerId: string): Promise<void> {
    await this.owned(threadId, ownerId);
    await this.control.deleteRoot(threadId, ownerId);
  }

  /**
   * The conversation as the web reads it (design-chat.md, ConversationView): the chat status, a page of
   * the root's history after `afterSeq`, its queue, the decisions of the whole tree in every status, the
   * agents under the root and the record in focus (deep-agents KD-6), read from the root's whole history.
   */
  async view(
    threadId: string,
    ownerId: string,
    afterSeq: number,
  ): Promise<ConversationView> {
    const thread = toThreadSummary(await this.owned(threadId, ownerId));
    const [task, views, entries, messages, confirmations, rootHistory] =
      await Promise.all([
        this.tasks.get(threadId, ownerId),
        this.views.list(threadId, ownerId),
        this.views.history({
          agentId: threadId,
          ownerId,
          afterSeq,
          limit: HISTORY_PAGE_SIZE,
        }),
        this.inbox.listPending(threadId, ownerId),
        this.views.confirmations(threadId, ownerId),
        this.wholeHistory(threadId, ownerId),
      ]);
    const root = views.find((view) => view.agentId === threadId);
    if (root === undefined)
      throw new Error(`Conversation ${threadId} has no view of its root`);
    const decisions = confirmations.map((confirmation) =>
      toConfirmation(confirmation, views),
    );
    return {
      thread,
      chat: {
        ...chatStatus({ root, task }),
        rootAgentId: threadId,
        model: root.model,
      },
      entries: entries.map(toHistoryEntry),
      nextAfterSeq: nextAfterSeqOf(entries),
      pending: toPending(messages, views, confirmations),
      decisions,
      agents: toAgentTree(views, threadId),
      focus: focusOf(
        rootHistory.map(toHistoryEntry),
        decisions.filter((decision) => decision.agentId === threadId),
      ),
    };
  }

  /** The root's history from its first entry, page by page. */
  private async wholeHistory(
    threadId: string,
    ownerId: string,
  ): Promise<AgentHistoryEntry[]> {
    const entries: AgentHistoryEntry[] = [];
    for (;;) {
      const page = await this.views.history({
        agentId: threadId,
        ownerId,
        afterSeq: entries.at(-1)?.seq ?? 0,
        limit: HISTORY_PAGE_SIZE,
      });
      entries.push(...page);
      if (page.length < HISTORY_PAGE_SIZE) return entries;
    }
  }

  /** The agents of the conversation under its root (AC-24.1). */
  async agentsTree(threadId: string, ownerId: string): Promise<AgentNode[]> {
    await this.owned(threadId, ownerId);
    return toAgentTree(await this.views.list(threadId, ownerId), threadId);
  }

  /**
   * Starts the root of the conversation `threadId` from its first message; `false` when the id is
   * taken (`TASK_EXISTS`: the start waited for the task that took it), and nothing was started.
   */
  private async start(
    threadId: string,
    ownerId: string,
    text: string,
    chip: { readonly record?: ChipRecord },
  ): Promise<boolean> {
    try {
      await this.starts.start({
        agentId: threadId,
        ownerId,
        prompt: text,
        description: Array.from(text)
          .slice(0, ROOT_DESCRIPTION_LENGTH)
          .join(''),
        ...chip,
      });
      return true;
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'TASK_EXISTS')
        return false;
      throw error;
    }
  }

  /**
   * The chip of a message: a record the employee's main chat may start (the one launch-set rule of
   * `agents`). An invisible, another's personal, a disabled, a missing record and an id that is not a
   * UUID (`resolve` answers it without a query) answer alike: 404 RECORD_NOT_FOUND of the library.
   */
  private async chipOf(ownerId: string, recordId: string): Promise<ChipRecord> {
    const resolved = await this.library.resolve(ownerId, recordId);
    if (resolved === null || !inRootLaunchSet(resolved))
      throw libraryError('RECORD_NOT_FOUND');
    return { id: resolved.id, kind: resolved.kind, name: resolved.name };
  }

  /** The owner's conversation; a malformed, missing or foreign id is `THREAD_NOT_FOUND`. */
  private async owned(threadId: string, ownerId: string): Promise<RootSession> {
    const root = isUuid(threadId)
      ? await this.views.root(threadId, ownerId)
      : undefined;
    if (root === undefined) throw threadNotFound();
    return root;
  }
}
