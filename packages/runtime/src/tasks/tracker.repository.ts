import {
  type TaskStatus,
  TaskStatusSchema,
  type TrackerStatus,
  TrackerStatusSchema,
} from '@agent-os/contracts';
import { type Database, runtimeTasks, runtimeTrackers, type Transaction } from '@agent-os/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { TaskFailure } from './guarded-transition';

export type TrackerRow = typeof runtimeTrackers.$inferSelect;

/** A task of a tracker as `trackers.list` returns it. */
export interface TrackerTask {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** The outcome of a `completed` task. */
  readonly result: unknown;
  /** The reason of a `failed` task. */
  readonly failure: TaskFailure | null;
}

/** A tracker with its tasks in the order the step gave them (deep-agents/design-task.md). */
export interface Tracker {
  readonly trackerId: string;
  readonly status: TrackerStatus;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly tasks: readonly TrackerTask[];
}

const { open, finished } = TrackerStatusSchema.enum;

/**
 * Drizzle queries of `runtime_trackers` inside the caller's transaction (repository over a
 * transaction). Every write runs under the lock of the owner task's row, which also orders the
 * ends of the tracker's tasks: each of them locks its parent, the owner, first.
 */
export class TrackerRepository {
  /** Inserts an `open` tracker of the owner task. */
  async insert(
    tx: Transaction,
    tracker: { trackerId: string; taskId: string; ownerId: string },
  ): Promise<void> {
    await tx.insert(runtimeTrackers).values({ ...tracker, status: open });
  }

  async find(tx: Transaction, trackerId: string): Promise<TrackerRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeTrackers)
      .where(eq(runtimeTrackers.trackerId, trackerId));
    return row;
  }

  /** Id and status of each task of the tracker, in the order they were created. */
  taskStatuses(
    tx: Transaction,
    trackerId: string,
  ): Promise<{ taskId: string; status: string }[]> {
    return tx
      .select({ taskId: runtimeTasks.taskId, status: runtimeTasks.status })
      .from(runtimeTasks)
      .where(eq(runtimeTasks.trackerId, trackerId))
      .orderBy(asc(runtimeTasks.createdSeq));
  }

  /** Marks the tracker `finished`; called once, at the end of its last task. */
  async finish(tx: Transaction, trackerId: string): Promise<void> {
    await tx
      .update(runtimeTrackers)
      .set({ status: finished, finishedAt: sql`now()` })
      .where(and(eq(runtimeTrackers.trackerId, trackerId), eq(runtimeTrackers.status, open)));
  }

  /**
   * The trackers of the owner's task, oldest first, each with its tasks and their outcomes. Another
   * owner's, a deleted or a missing task gives `[]`.
   */
  async list(db: Database, taskId: string, ownerId: string): Promise<Tracker[]> {
    const trackers = await db
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
          eq(runtimeTrackers.ownerId, ownerId),
          isNull(runtimeTasks.deletedAt),
        ),
      )
      .orderBy(asc(runtimeTrackers.createdAt), asc(runtimeTrackers.trackerId));
    if (trackers.length === 0) return [];

    const tasks = await db
      .select({
        trackerId: runtimeTasks.trackerId,
        taskId: runtimeTasks.taskId,
        status: runtimeTasks.status,
        result: runtimeTasks.result,
        failure: runtimeTasks.failure,
      })
      .from(runtimeTasks)
      .where(
        inArray(
          runtimeTasks.trackerId,
          trackers.map((tracker) => tracker.trackerId),
        ),
      )
      .orderBy(asc(runtimeTasks.createdSeq));

    return trackers.map((tracker) => ({
      trackerId: tracker.trackerId,
      status: TrackerStatusSchema.parse(tracker.status),
      createdAt: tracker.createdAt,
      finishedAt: tracker.finishedAt,
      tasks: tasks
        .filter((task) => task.trackerId === tracker.trackerId)
        .map((task) => ({
          taskId: task.taskId,
          status: TaskStatusSchema.parse(task.status),
          result: task.result,
          failure: task.failure as TaskFailure | null,
        })),
    }));
  }
}
