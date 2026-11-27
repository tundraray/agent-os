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
  DocumentRefSchema,
  HISTORY_PAGE_SIZE,
  THREAD_PAGE_SIZE,
  type AgentNode,
  type ChipRecord,
  type ConversationView,
  type Document,
  type HistoryEntry,
  type DocumentSummary,
  type ForkRequest,
  type InterruptResponse,
  type ScheduleMark,
  type SendMessageResponse,
  type ThreadDocumentsView,
  type ThreadForksResponse,
  type ThreadListResponse,
  type TestRunSummary,
  type ThreadSummary,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  ConversationTasksRepository,
  DocumentsRepository,
  RuntimeModelCallsRepository,
  type TrainingRow,
  TrainingsRepository,
} from '@agent-os/db';
import {
  Inbox,
  isFinished,
  QUESTION_TASK_TYPE,
  RuntimeError,
  type Task,
  TaskControl,
} from '@agent-os/runtime';
import { isUuid } from '../common/is-uuid';
import { libraryError } from '../library/library.errors';
import { LibraryService } from '../library/library.service';
import { chatStatus, conversationState } from './chat-status';
import { forkRefused, httpError, threadNotFound } from './chat.errors';
import {
  focusOf,
  nextAfterSeqOf,
  toAgentTree,
  toConfirmation,
  toHistoryEntry,
  toPending,
  trainingOf,
} from './conversation-view';
import { testRunSummary } from './test-run-summary';
import { encodeThreadCursor } from './thread-cursor';
import { decodeRowCursor, toThreadSummary } from './thread-summary';
import { rootDescription } from './root-description';
import { TitleService } from './title.service';

type TreeDocumentRow = Awaited<
  ReturnType<DocumentsRepository['listInTree']>
>[number];

/** A document row of the conversation's tree as the web reads it (design-notepad.md, «Маршруты беседы»). */
function toDocumentSummary({
  conversationId,
  status,
  updatedAt,
  ...row
}: TreeDocumentRow): DocumentSummary {
  return {
    ...row,
    agentId: conversationId,
    writing: !isFinished(status),
    updatedAt: updatedAt.toISOString(),
  };
}

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
    @Inject(DocumentsRepository)
    private readonly documentRows: DocumentsRepository,
    @Inject(TrainingsRepository)
    private readonly trainings: TrainingsRepository,
    @Inject(AgentsRepository)
    private readonly agents: AgentsRepository,
    @Inject(ConversationTasksRepository)
    private readonly sessionTasks: ConversationTasksRepository,
    @Inject(RuntimeModelCallsRepository)
    private readonly modelCalls: RuntimeModelCallsRepository,
    @Inject(ConversationsRepository)
    private readonly conversations: ConversationsRepository,
  ) {}

  /**
   * A page of the owner's conversations, last changed first (`THREAD_PAGE_SIZE`, `nextCursor`), each with its state
   * (improvements design-server.md, Flow 4): the facts of the whole page are read in one query.
   */
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
    const facts = new Map(
      (
        await this.conversations.stateFacts(
          page.map((root) => root.rootId),
          QUESTION_TASK_TYPE,
        )
      ).map((row) => [row.rootId, row]),
    );
    return {
      threads: page.map((root) => {
        const rootFacts = facts.get(root.rootId);
        return {
          ...toThreadSummary(root),
          state: rootFacts === undefined ? null : conversationState(rootFacts),
        };
      }),
      nextCursor:
        roots.length > THREAD_PAGE_SIZE && last
          ? encodeThreadCursor({ updatedAt: last.updatedAt, id: last.rootId })
          : null,
    };
  }

  /** The id of a new conversation. Nothing is written: the conversation appears with its first message. */
  create(): ThreadSummary {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: null,
      createdAt: now,
      updatedAt: now,
      forkable: true,
      forkedFrom: null,
      forkCount: 0,
    };
  }

  /**
   * Flow 1 of design-fork.md and Flow 3 of improvements design-server.md: forks the owner's conversation — whole or
   * through the message `throughSeq` into a new one waiting for a message, or before the message `edit.seq` with the
   * edited text, which the fork answers. The edit's chip is checked first, as a send's. A boundary on no message it
   * may end at is 400 `VALIDATION_FAILED`, a refusal by the tree 409 `FORK_REFUSED` with its reason, a refused start
   * 409 `START_REFUSED`; nothing is created.
   */
  async fork(
    threadId: string,
    ownerId: string,
    { throughSeq, edit }: ForkRequest,
  ): Promise<ThreadSummary> {
    await this.owned(threadId, ownerId);
    const record =
      edit?.recordId === undefined
        ? undefined
        : await this.chipOf(ownerId, edit.recordId);
    const forked = await this.starts.fork({
      threadId,
      ownerId,
      ...(edit !== undefined
        ? {
            boundary: {
              kind: 'edit',
              seq: edit.seq,
              text: edit.text,
              ...(record === undefined ? {} : { record }),
            },
          }
        : {}),
      ...(throughSeq !== undefined
        ? { boundary: { kind: 'through', throughSeq } }
        : {}),
    });
    if (forked.kind === 'not_a_message') throw httpError('VALIDATION_FAILED');
    if (forked.kind === 'refused') throw forkRefused(forked.reason);
    return this.get(forked.threadId, ownerId);
  }

  /** The owner's live forks of the conversation, newest first. */
  async forks(threadId: string, ownerId: string): Promise<ThreadForksResponse> {
    await this.owned(threadId, ownerId);
    const forks = await this.views.forks(threadId, ownerId);
    return { threads: forks.map(toThreadSummary) };
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
   *
   * A schedule's send (schedules KD-2, KD-6) carries its mark into the message or the root's `task` entry and the
   * title of a new conversation, and starts no title generation. Inside a caller's transaction every write of the
   * send joins it, so the caller commits the message or the new root with its own rows.
   */
  async send(
    threadId: string,
    ownerId: string,
    text: string,
    recordId?: string,
    scheduled?: { readonly schedule: ScheduleMark; readonly title?: string },
  ): Promise<SendMessageResponse> {
    if (!isUuid(threadId)) throw threadNotFound();
    const record =
      recordId === undefined ? undefined : await this.chipOf(ownerId, recordId);
    const chip = {
      ...(record === undefined ? {} : { record }),
      ...(scheduled === undefined ? {} : { schedule: scheduled.schedule }),
    };
    const existing = await this.views.root(threadId, ownerId);
    const created =
      existing === undefined &&
      (await this.start(threadId, ownerId, text, {
        ...chip,
        ...(scheduled?.title === undefined ? {} : { title: scheduled.title }),
      }));
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
    if (untitled && scheduled === undefined)
      this.titles.ensure({
        threadId,
        ownerId,
        ...(created ? { firstText: text } : {}),
      });
    return { messageId };
  }

  /**
   * Flow 4 of improvements design-server.md: raises the owner's «seen through» mark of the conversation, never down and
   * never past its last entry. A malformed, missing or foreign id is `THREAD_NOT_FOUND`.
   */
  async markSeen(
    threadId: string,
    ownerId: string,
    throughSeq: number,
  ): Promise<void> {
    const marked =
      isUuid(threadId) &&
      (await this.conversations.markSeen(threadId, ownerId, throughSeq));
    if (!marked) throw threadNotFound();
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
    const owned = await this.owned(threadId, ownerId);
    const thread = toThreadSummary(owned);
    const [
      task,
      views,
      entries,
      messages,
      confirmations,
      rootHistory,
      training,
    ] = await Promise.all([
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
      this.trainings.find(threadId),
    ]);
    const root = views.find((view) => view.agentId === threadId);
    if (root === undefined)
      throw new Error(`Conversation ${threadId} has no view of its root`);
    const decisions = confirmations.map((confirmation) =>
      toConfirmation(confirmation, views),
    );
    const history = rootHistory.map(toHistoryEntry);
    const run =
      training?.description == null
        ? null
        : await this.runSummary(training, task, history);
    return {
      thread,
      chat: {
        // A test run's conversation is an ordinary one while it takes a message (KD-9).
        ...chatStatus({
          root,
          task,
          training: training !== undefined && run?.canSend !== true,
        }),
        rootAgentId: threadId,
        model: root.model,
      },
      entries: entries.map(toHistoryEntry),
      nextAfterSeq: nextAfterSeqOf(entries),
      pending: toPending(messages, views, confirmations),
      decisions,
      agents: toAgentTree(views, threadId),
      focus: focusOf(
        history,
        decisions.filter((decision) => decision.agentId === threadId),
        views.filter((view) => view.parentId === threadId),
      ),
      training: trainingOf(
        training,
        threadId,
        training?.agentId != null &&
          (await this.agents.exists(training.agentId)),
        run,
      ),
      seenThroughSeq: owned.seenThroughSeq,
    };
  }

  /** The test run's summary (KD-9) from its row, root, pool, versions, spend and the trainer's whole history. */
  private async runSummary(
    row: TrainingRow,
    root: Task,
    entries: readonly HistoryEntry[],
  ): Promise<TestRunSummary> {
    const [pool, proposed, spent, agent, takenAgent] = await Promise.all([
      this.sessionTasks.list(row.id),
      this.agents.trainingVersions(row.id),
      this.modelCalls.sumTree(row.id),
      row.agentId === null ? undefined : this.agents.findAny(row.agentId),
      row.takenAgentId === null
        ? undefined
        : this.agents.findAny(row.takenAgentId),
    ]);
    return testRunSummary({
      row,
      root,
      pool,
      proposed: proposed.length,
      spentUsd: Number(spent),
      agent,
      takenAgent,
      entries,
    });
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

  /** The documents of every run in the conversation, most recently changed first (KD-7). */
  async documents(
    threadId: string,
    ownerId: string,
  ): Promise<ThreadDocumentsView> {
    await this.owned(threadId, ownerId);
    const rows = await this.documentRows.listInTree(threadId);
    return { documents: rows.map(toDocumentSummary) };
  }

  /**
   * One document of the conversation's runs. The rows are bound to the tree only, so the owner check is
   * here; a number that is not one, or of a document outside this tree, is `DOCUMENT_NOT_FOUND`.
   */
  async document(
    threadId: string,
    ownerId: string,
    documentId: string,
  ): Promise<Document> {
    await this.owned(threadId, ownerId);
    // The round trip rejects forms Number() accepts (" 12", "1e3", "012"), so a bad one never reaches Postgres.
    const id = Number(documentId);
    const row =
      String(id) === documentId &&
      DocumentRefSchema.shape.id.safeParse(id).success
        ? await this.documentRows.findInTree(threadId, id)
        : undefined;
    if (row === undefined) throw httpError('DOCUMENT_NOT_FOUND');
    return { ...toDocumentSummary(row), text: row.text };
  }

  /**
   * Starts the root of the conversation `threadId` from its first message; `false` when the id is
   * taken (`TASK_EXISTS`: the start waited for the task that took it), and nothing was started.
   */
  private async start(
    threadId: string,
    ownerId: string,
    text: string,
    chip: {
      readonly record?: ChipRecord;
      readonly schedule?: ScheduleMark;
      readonly title?: string;
    },
  ): Promise<boolean> {
    try {
      await this.starts.start({
        agentId: threadId,
        ownerId,
        prompt: text,
        description: rootDescription(text),
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
