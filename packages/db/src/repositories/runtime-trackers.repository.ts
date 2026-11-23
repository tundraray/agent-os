import { TrackerStatusSchema } from '@agent-os/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { runtimeTasks, runtimeTrackers } from '../schema';

export type RuntimeTrackerRow = typeof runtimeTrackers.$inferSelect;

const { open, finished } = TrackerStatusSchema.enum;

/**
 * Drizzle queries of `runtime_trackers`.
 */
export class RuntimeTrackersRepository {
  constructor(private readonly db: Db) {}

  /** Inserts an `open` tracker of the owner task. */
  async insert(tracker: { trackerId: string; taskId: string }): Promise<void> {
    await this.db.client
      .insert(runtimeTrackers)
      .values({ ...tracker, status: open });
  }

  /**
   * The tracker if it is `open`, by an UPDATE that changes nothing: another transaction that ends
   * a task of the tracker waits here until this one ends, and then reads what it wrote.
   */
  async holdOpen(trackerId: string): Promise<RuntimeTrackerRow | undefined> {
    const [row] = await this.db.client
      .update(runtimeTrackers)
      .set({ status: open })
      .where(
        and(
          eq(runtimeTrackers.trackerId, trackerId),
          eq(runtimeTrackers.status, open),
        ),
      )
      .returning();
    return row;
  }

  /** Id and status of each task of the tracker, in the order they were created. */
  taskStatuses(
    trackerId: string,
  ): Promise<{ taskId: string; status: string }[]> {
    return this.db.client
      .select({ taskId: runtimeTasks.taskId, status: runtimeTasks.status })
      .from(runtimeTasks)
      .where(eq(runtimeTasks.trackerId, trackerId))
      .orderBy(asc(runtimeTasks.createdSeq));
  }

  /** Marks the tracker `finished`; called once, at the end of its last task. */
  async finish(trackerId: string): Promise<void> {
    await this.db.client
      .update(runtimeTrackers)
      .set({ status: finished, finishedAt: sql`now()` })
      .where(
        and(
          eq(runtimeTrackers.trackerId, trackerId),
          eq(runtimeTrackers.status, open),
        ),
      );
  }

  /**
   * The trackers of the owner's task, oldest first; the owner is the task's. Another owner's, a deleted or a
   * missing task gives `[]`.
   */
  listOwned(taskId: string, ownerId: string) {
    return this.db.client
      .select({
        trackerId: runtimeTrackers.trackerId,
        status: runtimeTrackers.status,
        createdAt: runtimeTrackers.createdAt,
        finishedAt: runtimeTrackers.finishedAt,
      })
      .from(runtimeTrackers)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, runtimeTrackers.taskId))
      .where(
        and(
          eq(runtimeTrackers.taskId, taskId),
          eq(runtimeTasks.ownerId, ownerId),
          isNull(runtimeTasks.deletedAt),
        ),
      )
      .orderBy(asc(runtimeTrackers.createdAt), asc(runtimeTrackers.trackerId));
  }

  /** The tasks of the given trackers with their outcomes, in the order they were created. */
  listTasks(trackerIds: readonly string[]) {
    return this.db.client
      .select({
        trackerId: runtimeTasks.trackerId,
        taskId: runtimeTasks.taskId,
        status: runtimeTasks.status,
        result: runtimeTasks.result,
        failure: runtimeTasks.failure,
      })
      .from(runtimeTasks)
      .where(inArray(runtimeTasks.trackerId, [...trackerIds]))
      .orderBy(asc(runtimeTasks.createdSeq));
  }
}
