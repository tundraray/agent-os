import { TrackerStatusSchema } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { runtimeTasks, runtimeTrackers } from '../schema';

export type RuntimeTrackerRow = typeof runtimeTrackers.$inferSelect;

const { open, finished } = TrackerStatusSchema.enum;

/**
 * Drizzle queries of `runtime_trackers` inside the caller's transaction (repository over a
 * transaction). Every write runs under the lock of the owner task's row, which also orders the
 * ends of the tracker's tasks: each of them locks its parent, the owner, first.
 */
@Injectable()
export class RuntimeTrackersRepository {
  /** Inserts an `open` tracker of the owner task. */
  async insert(
    tx: Transaction,
    tracker: { trackerId: string; taskId: string; ownerId: string },
  ): Promise<void> {
    await tx.insert(runtimeTrackers).values({ ...tracker, status: open });
  }

  async find(tx: Transaction, trackerId: string): Promise<RuntimeTrackerRow | undefined> {
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
   * The trackers of the owner's task, oldest first. Another owner's, a deleted or a missing task
   * gives `[]`.
   */
  listOwned(executor: Executor, taskId: string, ownerId: string) {
    return executor
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
  }

  /** The tasks of the given trackers with their outcomes, in the order they were created. */
  listTasks(executor: Executor, trackerIds: readonly string[]) {
    return executor
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
