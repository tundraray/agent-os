import type { TrackerTaskStatus } from '@agent-os/contracts';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  conversations,
  runtimeTasks,
  trackerTaskConversations,
  trackerTaskEvents,
  trackerTasks,
} from '../schema';

export type TrackerTaskRow = typeof trackerTasks.$inferSelect;
export type TrackerTaskLinkRow = typeof trackerTaskConversations.$inferSelect;
export type TrackerTaskEventRow = typeof trackerTaskEvents.$inferSelect;

export type NewTrackerTaskRow = Pick<
  typeof trackerTasks.$inferInsert,
  'ownerId' | 'title' | 'description' | 'status'
>;
export type NewTrackerTaskLinkRow = Omit<
  typeof trackerTaskConversations.$inferInsert,
  'delegatedAt'
>;
export type NewTrackerTaskEventRow = Omit<
  typeof trackerTaskEvents.$inferInsert,
  'id' | 'createdAt'
>;

/** The fields a change of a task writes; every change raises `updated_at`. */
export type TrackerTaskChange = Partial<
  Pick<TrackerTaskRow, 'title' | 'description' | 'status'>
>;

/** A link with its conversation's title now and the deletion mark of its root. */
export type TrackerTaskLinkListRow = {
  readonly link: TrackerTaskLinkRow;
  /** Empty while the conversation has no title. */
  readonly conversationTitle: string;
  readonly conversationDeletedAt: Date | null;
};

/** The link of a conversation with the task it belongs to. */
export type TrackerConversationTaskRow = {
  readonly link: TrackerTaskLinkRow;
  readonly task: TrackerTaskRow;
};

const ownedTask = (id: string, ownerId: string) =>
  and(eq(trackerTasks.id, id), eq(trackerTasks.ownerId, ownerId));

/**
 * Drizzle queries of `tracker_tasks`, `tracker_task_conversations` and `tracker_task_events` (task-tracker
 * design-server.md, Data Model). Every read and write of a task is under its owner; a feed row is only inserted
 * (rule 3).
 */
export class TrackerTasksRepository {
  constructor(private readonly db: Db) {}

  async insert(row: NewTrackerTaskRow): Promise<TrackerTaskRow> {
    const [inserted] = await this.db.client
      .insert(trackerTasks)
      .values(row)
      .returning();
    if (inserted === undefined)
      throw new Error('tracker_tasks insert returned no row');
    return inserted;
  }

  /** The owner's task; another owner's is as absent as a missing one. */
  async findOwned(
    id: string,
    ownerId: string,
  ): Promise<TrackerTaskRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(trackerTasks)
      .where(ownedTask(id, ownerId));
    return row;
  }

  /** The owner's tasks in these statuses, recently changed first. */
  listOwned(
    ownerId: string,
    statuses: readonly TrackerTaskStatus[],
  ): Promise<TrackerTaskRow[]> {
    return this.db.client
      .select()
      .from(trackerTasks)
      .where(
        and(
          eq(trackerTasks.ownerId, ownerId),
          inArray(trackerTasks.status, [...statuses]),
        ),
      )
      .orderBy(desc(trackerTasks.updatedAt), desc(trackerTasks.id));
  }

  /** Changes the owner's task and raises `updated_at`; `undefined` for another owner's or a missing one. */
  async update(
    id: string,
    ownerId: string,
    change: TrackerTaskChange,
  ): Promise<TrackerTaskRow | undefined> {
    const [row] = await this.db.client
      .update(trackerTasks)
      .set({ ...change, updatedAt: sql`now()` })
      .where(ownedTask(id, ownerId))
      .returning();
    return row;
  }

  /**
   * Sets the status of the task unless it is in one of `unless`, and raises `updated_at`; `undefined` — the status
   * was left, or the task is gone. The check and the change are one write.
   */
  async updateStatusUnless(
    id: string,
    status: TrackerTaskStatus,
    unless: readonly TrackerTaskStatus[],
  ): Promise<TrackerTaskRow | undefined> {
    const [row] = await this.db.client
      .update(trackerTasks)
      .set({ status, updatedAt: sql`now()` })
      .where(
        and(
          eq(trackerTasks.id, id),
          notInArray(trackerTasks.status, [...unless]),
        ),
      )
      .returning();
    return row;
  }

  /** Deletes the owner's task with its links and feed; false for another owner's or a missing one. */
  async delete(id: string, ownerId: string): Promise<boolean> {
    const deleted = await this.db.client
      .delete(trackerTasks)
      .where(ownedTask(id, ownerId))
      .returning({ id: trackerTasks.id });
    return deleted.length > 0;
  }

  /** The ids of the task's conversations, deleted ones too. */
  async conversationIds(taskId: string): Promise<string[]> {
    const rows = await this.db.client
      .select({ id: trackerTaskConversations.conversationId })
      .from(trackerTaskConversations)
      .where(eq(trackerTaskConversations.taskId, taskId));
    return rows.map((row) => row.id);
  }

  /** The links of these tasks with their conversations, the latest delegation first. */
  links(taskIds: readonly string[]): Promise<TrackerTaskLinkListRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.client
      .select({
        link: trackerTaskConversations,
        conversationTitle: sql<string>`coalesce(${conversations.title}, '')`,
        conversationDeletedAt: runtimeTasks.deletedAt,
      })
      .from(trackerTaskConversations)
      .innerJoin(
        conversations,
        eq(conversations.id, trackerTaskConversations.conversationId),
      )
      .innerJoin(
        runtimeTasks,
        eq(runtimeTasks.taskId, trackerTaskConversations.conversationId),
      )
      .where(inArray(trackerTaskConversations.taskId, [...taskIds]))
      .orderBy(
        desc(trackerTaskConversations.delegatedAt),
        desc(trackerTaskConversations.conversationId),
      );
  }

  /** The link of a conversation with its task; `undefined` — the conversation belongs to no task. */
  async findByConversation(
    conversationId: string,
  ): Promise<TrackerConversationTaskRow | undefined> {
    const [row] = await this.db.client
      .select({ link: trackerTaskConversations, task: trackerTasks })
      .from(trackerTaskConversations)
      .innerJoin(
        trackerTasks,
        eq(trackerTasks.id, trackerTaskConversations.taskId),
      )
      .where(eq(trackerTaskConversations.conversationId, conversationId));
    return row;
  }

  async insertLink(row: NewTrackerTaskLinkRow): Promise<void> {
    await this.db.client.insert(trackerTaskConversations).values(row);
  }

  /** The task's feed rows, oldest first. */
  events(taskId: string): Promise<TrackerTaskEventRow[]> {
    return this.db.client
      .select()
      .from(trackerTaskEvents)
      .where(eq(trackerTaskEvents.taskId, taskId))
      .orderBy(asc(trackerTaskEvents.createdAt));
  }

  async insertEvent(row: NewTrackerTaskEventRow): Promise<void> {
    await this.db.client.insert(trackerTaskEvents).values(row);
  }
}
