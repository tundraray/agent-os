import { TaskStatusSchema, type TaskEdgeKind } from '@agent-os/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  researchInvestigations,
  researchTaskDependencies,
  researchTasks,
  researchTaskSubscribers,
} from '@agent-os/db';
import {
  guardedTaskWrite,
  type RuntimeTx,
  type TaskChange,
  type TaskGuard,
  type TaskRow,
} from './guarded-transition.js';

export type InvestigationRow = typeof researchInvestigations.$inferSelect;
export type NewTaskRow = typeof researchTasks.$inferInsert;

export interface TaskEdge {
  investigationId: string;
  taskId: string;
  dependsOnTaskId: string;
  kind: TaskEdgeKind;
}

/**
 * Predicate of the partial UNIQUE `research_tasks_live_dedup_key_idx`, written with literals:
 * ON CONFLICT infers the arbiter index only from a predicate that implies the index's own.
 * The values are code constants of the contract enum (ADR-0003: `sql.raw` only for constants).
 */
const LIVE_DEDUP_KEY_PREDICATE = sql`${researchTasks.status} in (${sql.raw(
  TaskStatusSchema.exclude(['failed', 'cancelled'])
    .options.map((status) => `'${status}'`)
    .join(', '),
)})`;

/**
 * Drizzle queries of investigations and tasks inside the caller's transaction.
 *
 * Lock order (System Invariants): the investigation first (`lockInvestigation`, FOR NO KEY
 * UPDATE), then tasks by `task_id` (`lockTasks`, or the guarded write of one task). Task rows
 * change only through {@link guardedTaskWrite}.
 */
export class TaskRepository {
  /** Locks the investigation FOR NO KEY UPDATE; the first lock of a multi-task transaction. */
  async lockInvestigation(
    tx: RuntimeTx,
    investigationId: string,
  ): Promise<InvestigationRow | undefined> {
    const [row] = await tx
      .select()
      .from(researchInvestigations)
      .where(eq(researchInvestigations.investigationId, investigationId))
      .for('no key update');
    return row;
  }

  /** Locks the tasks FOR UPDATE in `task_id` order; call under the investigation lock. */
  async lockTasks(
    tx: RuntimeTx,
    taskIds: readonly string[],
  ): Promise<TaskRow[]> {
    if (taskIds.length === 0) return [];
    return tx
      .select()
      .from(researchTasks)
      .where(inArray(researchTasks.taskId, [...taskIds]))
      .orderBy(asc(researchTasks.taskId))
      .for('update');
  }

  async findTask(tx: RuntimeTx, taskId: string): Promise<TaskRow | undefined> {
    const [row] = await tx
      .select()
      .from(researchTasks)
      .where(eq(researchTasks.taskId, taskId));
    return row;
  }

  /** The live task (`queued`, `running`, `waiting`, `succeeded`) holding the dedup key. */
  async findLiveTask(
    tx: RuntimeTx,
    investigationId: string,
    dedupKey: string,
  ): Promise<TaskRow | undefined> {
    const [row] = await tx
      .select()
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.investigationId, investigationId),
          eq(researchTasks.dedupKey, dedupKey),
          LIVE_DEDUP_KEY_PREDICATE,
        ),
      );
    return row;
  }

  /**
   * Inserts a task; `undefined` when a live task of the investigation already holds its dedup
   * key (ON CONFLICT DO NOTHING on the partial UNIQUE).
   */
  async insertTask(
    tx: RuntimeTx,
    task: NewTaskRow,
  ): Promise<TaskRow | undefined> {
    const [row] = await tx
      .insert(researchTasks)
      .values(task)
      .onConflictDoNothing({
        target: [researchTasks.investigationId, researchTasks.dedupKey],
        where: LIVE_DEDUP_KEY_PREDICATE,
      })
      .returning();
    return row;
  }

  async insertEdges(tx: RuntimeTx, edges: readonly TaskEdge[]): Promise<void> {
    if (edges.length === 0) return;
    await tx.insert(researchTaskDependencies).values([...edges]);
  }

  /** Adds the subscriber once; `false` when it was already subscribed. */
  async addSubscriber(
    tx: RuntimeTx,
    taskId: string,
    subscriberKey: string,
  ): Promise<boolean> {
    const rows = await tx
      .insert(researchTaskSubscribers)
      .values({ taskId, subscriberKey })
      .onConflictDoNothing()
      .returning({ taskId: researchTaskSubscribers.taskId });
    return rows.length > 0;
  }

  /** The guarded write of one task; `undefined` when fenced. */
  transition(
    tx: RuntimeTx,
    guard: TaskGuard,
    change: TaskChange,
  ): Promise<TaskRow | undefined> {
    return guardedTaskWrite(tx, guard, change);
  }
}
