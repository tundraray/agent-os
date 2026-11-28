import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AgentsError, signalConversation } from '@agent-os/agents';
import {
  type ConversationState,
  type TrackerCommentBody,
  type TrackerDelegationBody,
  type TrackerDelegationResponse,
  type TrackerFeedItem,
  type TrackerReportArgs,
  type TrackerTaskConversation,
  type TrackerTaskCreateBody,
  type TrackerTaskListResponse,
  type TrackerTaskPatchBody,
  type TrackerTaskStatus,
  TrackerAuthorSchema,
  TrackerTaskStatusSchema,
  type TrackerTaskView,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  Db,
  RuntimeTasksRepository,
  type TrackerTaskEventRow,
  type TrackerTaskLinkListRow,
  type TrackerTaskRow,
  TrackerTasksRepository,
} from '@agent-os/db';
import { QUESTION_TASK_TYPE } from '@agent-os/runtime';
import { conversationState } from '../chat/chat-status';
import { ConversationsService } from '../chat/conversations.service';
import { isUuid } from '../common/is-uuid';
import {
  START_MESSAGE_COMMENTS,
  type StartMessageComment,
  startMessage,
} from './start-message';
import { taskState } from './tracker-state';
import { trackerError } from './tracker.errors';

const { todo, in_progress, in_review, needs_decision, done, cancelled } =
  TrackerTaskStatusSchema.enum;

/** The statuses only the employee leaves: `tracker_report` changes no status of a closed task (Invariant 1). */
const CLOSED_STATUSES: readonly TrackerTaskStatus[] = [done, cancelled];

/** What a `tracker_report` call did (Contract «Инструмент `tracker_report`»). */
export type TrackerReportOutcome = 'reported' | 'task_deleted' | 'task_closed';

/**
 * The send to a conversation the employee deleted meanwhile (KD-5): its id is taken by its rows (`THREAD_NOT_FOUND`
 * of the send), or the delete and the send took turns on the root (`AGENT_NOT_FOUND` of `agents`).
 */
const conversationGone = (error: unknown): boolean =>
  (error instanceof HttpException && error.getStatus() === 404) ||
  (error instanceof AgentsError && error.code === 'AGENT_NOT_FOUND');

/** The list without `status`: every task but `done` and `cancelled` (AC-01.3). */
const OPEN_STATUSES: readonly TrackerTaskStatus[] = [
  todo,
  in_progress,
  in_review,
  needs_decision,
];

/** The order of feed entries written at one moment, in one transaction (DC-4): a note before its delegation. */
const FEED_RANK: Record<TrackerFeedItem['kind'], number> = {
  created: 0,
  comment: 1,
  delegated: 2,
  status: 3,
};

const isLive = (row: TrackerTaskLinkListRow): boolean =>
  row.conversationDeletedAt === null;

/**
 * The last comments of the feed for the start message, oldest first, each with its author: an agent's under the
 * name its conversation's link keeps; the delegation's note goes last.
 */
function lastComments(
  events: readonly TrackerTaskEventRow[],
  links: readonly TrackerTaskLinkListRow[],
  note: string | undefined,
): StartMessageComment[] {
  const nameOf = new Map(
    links.map(({ link }) => [link.conversationId, link.agentName]),
  );
  const comments = events.flatMap((row): StartMessageComment[] => {
    if (row.kind !== 'comment' || row.text === null) return [];
    if (row.author === 'employee')
      return [{ author: 'employee', text: row.text }];
    const agentName =
      row.conversationId === null
        ? null
        : (nameOf.get(row.conversationId) ?? null);
    return [{ author: { agentName }, text: row.text }];
  });
  if (note !== undefined) comments.push({ author: 'employee', text: note });
  return comments.slice(-START_MESSAGE_COMMENTS);
}

function toFeedItem(row: TrackerTaskEventRow): TrackerFeedItem {
  const at = row.createdAt.toISOString();
  const author = TrackerAuthorSchema.parse(row.author);
  if (row.kind === 'status')
    return {
      kind: 'status',
      at,
      status: TrackerTaskStatusSchema.parse(row.status),
      author,
      conversationId: row.conversationId,
    };
  if (row.text === null)
    throw new Error(`Tracker comment ${row.id} has no text`);
  return {
    kind: 'comment',
    at,
    id: row.id,
    author,
    text: row.text,
    conversationId: row.conversationId,
  };
}

/** The task's feed, oldest first: its creation, its delegations from the links and its stored entries (KD-6). */
function feedOf(
  task: TrackerTaskRow,
  links: readonly TrackerTaskLinkListRow[],
  events: readonly TrackerTaskEventRow[],
): TrackerFeedItem[] {
  const items: TrackerFeedItem[] = [
    { kind: 'created', at: task.createdAt.toISOString() },
    ...links.map(({ link }): TrackerFeedItem => ({
      kind: 'delegated',
      at: link.delegatedAt.toISOString(),
      conversationId: link.conversationId,
    })),
    ...events.map(toFeedItem),
  ];
  return items.sort(
    (a, b) => a.at.localeCompare(b.at) || FEED_RANK[a.kind] - FEED_RANK[b.kind],
  );
}

function toConversation(
  row: TrackerTaskLinkListRow,
  states: ReadonlyMap<string, ConversationState | null>,
): TrackerTaskConversation {
  const { link } = row;
  return {
    id: link.conversationId,
    title: row.conversationTitle,
    agent:
      link.agentName === null
        ? null
        : { id: link.agentId, name: link.agentName },
    delegatedAt: link.delegatedAt.toISOString(),
    deleted: !isLive(row),
    state: isLive(row) ? (states.get(link.conversationId) ?? null) : null,
  };
}

/**
 * An employee's tracker tasks (task-tracker design-server.md, C3 «список задач», Flow 3): the routes' rules. The
 * owner is the session's; another employee's task answers as a missing one, and so does an id that is not a UUID.
 * The state of the conversations is read with the chat list's facts, once per read (KD-6). A change of the title
 * and a delete send `change` `summary` to each conversation of the task, in the transaction of the write (KD-1).
 */
@Injectable()
export class TrackerService {
  constructor(
    private readonly db: Db,
    @Inject(TrackerTasksRepository)
    private readonly tasks: TrackerTasksRepository,
    @Inject(ConversationsRepository)
    private readonly conversations: ConversationsRepository,
    /** The sender of the conversation's own events (`signalConversation`). */
    @Inject(RuntimeTasksRepository)
    private readonly signals: RuntimeTasksRepository,
    @Inject(AgentsRepository) private readonly agents: AgentsRepository,
    private readonly chats: ConversationsService,
  ) {}

  /** The owner's tasks, recently changed first, each with the state of its live conversations. */
  async list(
    ownerId: string,
    status: TrackerTaskStatus | undefined,
  ): Promise<TrackerTaskListResponse> {
    const rows = await this.tasks.listOwned(
      ownerId,
      status === undefined ? OPEN_STATUSES : [status],
    );
    const links = (await this.tasks.links(rows.map((row) => row.id))).filter(
      isLive,
    );
    const states = await this.statesOf(links);
    return {
      tasks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: TrackerTaskStatusSchema.parse(row.status),
        updatedAt: row.updatedAt.toISOString(),
        state: taskState(
          links
            .filter(({ link }) => link.taskId === row.id)
            .map(({ link }) => states.get(link.conversationId) ?? null),
        ),
      })),
    };
  }

  async create(
    ownerId: string,
    body: TrackerTaskCreateBody,
  ): Promise<TrackerTaskView> {
    const task = await this.tasks.insert({
      ownerId,
      title: body.title,
      description: body.description,
      status: todo,
    });
    return this.toView(task);
  }

  async get(id: string, ownerId: string): Promise<TrackerTaskView> {
    return this.toView(await this.owned(id, ownerId));
  }

  /**
   * Changes the title, the description or the status (AC-02.1): a status really changed is a feed entry of the
   * employee (DC-3), a title really changed is `summary` of each conversation of the task (DC-8).
   */
  async update(
    id: string,
    ownerId: string,
    patch: TrackerTaskPatchBody,
  ): Promise<TrackerTaskView> {
    const task = await this.db.transaction(async () => {
      const before = await this.owned(id, ownerId);
      const after = await this.tasks.update(id, ownerId, patch);
      if (after === undefined) throw trackerError('TRACKER_TASK_NOT_FOUND');
      if (patch.status !== undefined && patch.status !== before.status)
        await this.tasks.insertEvent({
          taskId: id,
          kind: 'status',
          author: TrackerAuthorSchema.enum.employee,
          conversationId: null,
          text: null,
          status: patch.status,
        });
      if (patch.title !== undefined && patch.title !== before.title)
        await this.signalSummary(ownerId, await this.tasks.conversationIds(id));
      return after;
    });
    return this.toView(task);
  }

  /**
   * Deletes the task with its feed and links; the conversations stay (AC-09.2). Their ids are read before the
   * delete, and each gets `summary` (DC-8).
   */
  async delete(id: string, ownerId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.owned(id, ownerId);
      const conversationIds = await this.tasks.conversationIds(id);
      if (!(await this.tasks.delete(id, ownerId)))
        throw trackerError('TRACKER_TASK_NOT_FOUND');
      await this.signalSummary(ownerId, conversationIds);
    });
  }

  /**
   * The employee's comment (AC-03.2), and with `forward` (Flow 3, KD-5) its text as a message without a chip to the
   * live conversation delegated last, in one transaction: none is live, or it was deleted before the send — 409
   * `TRACKER_NO_CONVERSATION`, nothing written. The send writes the conversation's root before the task's row.
   */
  async comment(
    id: string,
    ownerId: string,
    body: TrackerCommentBody,
  ): Promise<TrackerTaskView> {
    const task = await this.db.transaction(async () => {
      await this.owned(id, ownerId);
      const conversationId = body.forward
        ? await this.forward(id, ownerId, body.text)
        : null;
      const touched = await this.touched(id, ownerId);
      await this.tasks.insertEvent({
        taskId: id,
        kind: 'comment',
        author: TrackerAuthorSchema.enum.employee,
        conversationId,
        text: body.text,
        status: null,
      });
      return touched;
    });
    return this.toView(task);
  }

  /**
   * Flow 1, KD-2: one transaction — the start message to a new conversation with the task's title and the tracker
   * mark, then `in_progress` without a status entry, the note as the employee's comment and the link with the
   * agent's name now. A refused send (404 `RECORD_NOT_FOUND`, 409 `START_REFUSED`) rolls everything back and leaves
   * as it came; a task deleted meanwhile is 404 `TRACKER_TASK_NOT_FOUND`. No quota is checked here (AC-04.5).
   */
  async delegate(
    id: string,
    ownerId: string,
    body: TrackerDelegationBody,
  ): Promise<TrackerDelegationResponse> {
    const conversationId = randomUUID();
    const task = await this.db.transaction(async () => {
      const before = await this.owned(id, ownerId);
      const events = await this.tasks.events(id);
      const links = await this.tasks.links([id]);
      const text = startMessage({
        language: body.language,
        title: before.title,
        description: before.description,
        comments: lastComments(events, links, body.note),
        withAgent: body.agentId !== null,
      });
      await this.chats.sendWithoutKey(
        conversationId,
        ownerId,
        text,
        body.agentId ?? undefined,
        { title: before.title, trackerTask: true },
      );
      const delegated = await this.tasks.update(id, ownerId, {
        status: in_progress,
      });
      if (delegated === undefined) throw trackerError('TRACKER_TASK_NOT_FOUND');
      if (body.note !== undefined)
        await this.tasks.insertEvent({
          taskId: id,
          kind: 'comment',
          author: TrackerAuthorSchema.enum.employee,
          conversationId,
          text: body.note,
          status: null,
        });
      await this.tasks.insertLink({
        conversationId,
        taskId: id,
        agentId: body.agentId,
        agentName:
          body.agentId === null ? null : await this.agentName(body.agentId),
      });
      return delegated;
    });
    return { conversationId, task: await this.toView(task) };
  }

  /**
   * `tracker_report` of the chat of the conversation `rootId` (Flow 2): the task is the one its link names, never
   * an argument (AC-07.2). No link — `task_deleted`, nothing written (AC-07.4); a closed task keeps its status and
   * gets the comment — `task_closed` (AC-02.3). The comment is the delegation agent's (AC-03.1); `updatedAt` rises
   * only when something is written. Runs in the step's commit, which holds the conversation's root first.
   */
  async report(
    rootId: string,
    args: TrackerReportArgs,
  ): Promise<{ outcome: TrackerReportOutcome; taskId: string | null }> {
    const found = await this.tasks.findByConversation(rootId);
    if (found === undefined) return { outcome: 'task_deleted', taskId: null };
    const { id, ownerId } = found.task;
    const changed =
      args.status === undefined
        ? undefined
        : await this.tasks.updateStatusUnless(id, args.status, [
            ...CLOSED_STATUSES,
            args.status,
          ]);
    const current =
      changed ??
      (args.comment === undefined
        ? await this.tasks.findOwned(id, ownerId)
        : await this.tasks.update(id, ownerId, {}));
    if (current === undefined) return { outcome: 'task_deleted', taskId: id };
    if (args.comment !== undefined)
      await this.tasks.insertEvent({
        taskId: id,
        kind: 'comment',
        author: TrackerAuthorSchema.enum.agent,
        conversationId: rootId,
        text: args.comment,
        status: null,
      });
    if (changed !== undefined && args.status !== undefined)
      await this.tasks.insertEvent({
        taskId: id,
        kind: 'status',
        author: TrackerAuthorSchema.enum.agent,
        conversationId: rootId,
        text: null,
        status: args.status,
      });
    const closed =
      args.status !== undefined &&
      changed === undefined &&
      CLOSED_STATUSES.includes(TrackerTaskStatusSchema.parse(current.status));
    return { outcome: closed ? 'task_closed' : 'reported', taskId: id };
  }

  /** Sends the comment to the task's live conversation delegated last; its id, or 409 `TRACKER_NO_CONVERSATION`. */
  private async forward(
    id: string,
    ownerId: string,
    text: string,
  ): Promise<string> {
    const target = (await this.tasks.links([id])).find(isLive);
    if (target === undefined) throw trackerError('TRACKER_NO_CONVERSATION');
    const { conversationId } = target.link;
    try {
      await this.chats.sendWithoutKey(conversationId, ownerId, text, undefined);
    } catch (error) {
      if (conversationGone(error))
        throw trackerError('TRACKER_NO_CONVERSATION');
      throw error;
    }
    return conversationId;
  }

  /** Raises the task's `updatedAt` before a feed entry: a task deleted meanwhile is `TRACKER_TASK_NOT_FOUND`. */
  private async touched(id: string, ownerId: string): Promise<TrackerTaskRow> {
    const row = await this.tasks.update(id, ownerId, {});
    if (row === undefined) throw trackerError('TRACKER_TASK_NOT_FOUND');
    return row;
  }

  /** The name of the delegation's agent now: the send's chip rule has just passed it, so its row exists. */
  private async agentName(agentId: string): Promise<string> {
    const row = await this.agents.findAny(agentId);
    if (row === undefined)
      throw new Error(`Delegation agent ${agentId} has no row`);
    return row.name;
  }

  /** The owner's task; a malformed, missing or foreign id is `TRACKER_TASK_NOT_FOUND`. */
  private async owned(id: string, ownerId: string): Promise<TrackerTaskRow> {
    const row = isUuid(id)
      ? await this.tasks.findOwned(id, ownerId)
      : undefined;
    if (row === undefined) throw trackerError('TRACKER_TASK_NOT_FOUND');
    return row;
  }

  /** `change` `summary` of each conversation to its owner, sent when the open transaction commits (KD-1). */
  private async signalSummary(
    ownerId: string,
    conversationIds: readonly string[],
  ): Promise<void> {
    for (const threadId of conversationIds)
      await signalConversation(this.signals, {
        ownerId,
        event: { type: 'change', data: { threadId, kind: 'summary' } },
      });
  }

  /** The state of each live conversation, from one read of the facts (KD-6). */
  private async statesOf(
    live: readonly TrackerTaskLinkListRow[],
  ): Promise<Map<string, ConversationState | null>> {
    const facts = await this.conversations.stateFacts(
      live.map(({ link }) => link.conversationId),
      QUESTION_TASK_TYPE,
    );
    return new Map(facts.map((row) => [row.rootId, conversationState(row)]));
  }

  /** The task's screen: the task, its feed, its links and the facts of its live conversations, each read once. */
  private async toView(task: TrackerTaskRow): Promise<TrackerTaskView> {
    const events = await this.tasks.events(task.id);
    const links = await this.tasks.links([task.id]);
    const states = await this.statesOf(links.filter(isLive));
    const forward = links.find(isLive);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: TrackerTaskStatusSchema.parse(task.status),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      conversations: links.map((row) => toConversation(row, states)),
      feed: feedOf(task, links, events),
      forwardTo:
        forward === undefined
          ? null
          : {
              conversationId: forward.link.conversationId,
              title: forward.conversationTitle,
            },
    };
  }
}
