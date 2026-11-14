import { TaskStatusSchema } from '@agent-os/contracts';
import { runtimeTasks } from '@agent-os/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  guardedTaskWrite,
  type TaskChange,
  type TaskGuard,
  type TaskRow,
} from './guarded-transition.js';
import type { RuntimeTx } from './runtime-tx.js';

export type NewTaskRow = Pick<
  typeof runtimeTasks.$inferInsert,
  'taskId' | 'type' | 'ownerId' | 'parentId' | 'rootId' | 'depth' | 'input'
>;

/**
 * Drizzle queries of `runtime_tasks` inside the caller's transaction (repository over a
 * transaction). Lock order: a parent before its children, tasks of one level by `task_id`. Task
 * rows change only through {@link guardedTaskWrite}.
 */
export class TaskRepository {
  /** Locks the task FOR UPDATE. */
  async lock(tx: RuntimeTx, taskId: string): Promise<TaskRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, taskId))
      .for('update');
    return row;
  }

  /**
   * Locks the task FOR KEY SHARE: it cannot be deleted meanwhile, while guarded writes of it go
   * on. `false` when it no longer exists.
   */
  async lockAgainstDelete(tx: RuntimeTx, taskId: string): Promise<boolean> {
    const rows = await tx
      .select({ taskId: runtimeTasks.taskId })
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, taskId))
      .for('key share');
    return rows.length > 0;
  }

  /** Locks the owner's task FOR UPDATE; another owner's task is as absent as a missing one. */
  async lockOwned(
    tx: RuntimeTx,
    taskId: string,
    ownerId: string,
  ): Promise<TaskRow | undefined> {
    const row = await this.lock(tx, taskId);
    return row?.ownerId === ownerId ? row : undefined;
  }

  /**
   * Locks the task's parent FOR UPDATE, then the task: the lock of a write that may end the task,
   * whose end notice goes to the parent. A parent before its children in every transaction keeps
   * an ending child and a stop of its parent from deadlocking (plan Notes 4, Invariant 6).
   */
  async lockWithParent(tx: RuntimeTx, taskId: string): Promise<TaskRow | undefined> {
    const [found] = await tx
      .select({ parentId: runtimeTasks.parentId })
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, taskId));
    if (!found) return undefined;
    if (found.parentId !== null) await this.lock(tx, found.parentId);
    return this.lock(tx, taskId);
  }

  /**
   * Locks every child of the given tasks FOR UPDATE, finished or not, in `task_id` order: an
   * unfinished grandchild may sit under a finished child, and a locked child cannot be revived
   * meanwhile.
   */
  async lockChildren(tx: RuntimeTx, parentIds: readonly string[]): Promise<TaskRow[]> {
    if (parentIds.length === 0) return [];
    return tx
      .select()
      .from(runtimeTasks)
      .where(inArray(runtimeTasks.parentId, [...parentIds]))
      .orderBy(asc(runtimeTasks.taskId))
      .for('update');
  }

  /** The owner's task without a lock; another owner's task is as absent as a missing one. */
  async findOwned(
    tx: RuntimeTx,
    taskId: string,
    ownerId: string,
  ): Promise<TaskRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeTasks)
      .where(
        and(eq(runtimeTasks.taskId, taskId), eq(runtimeTasks.ownerId, ownerId)),
      );
    return row;
  }

  /** Every task of the owner's tree in creation order; `[]` for another owner's or no tree. */
  listTree(tx: RuntimeTx, rootId: string, ownerId: string): Promise<TaskRow[]> {
    return tx
      .select()
      .from(runtimeTasks)
      .where(
        and(eq(runtimeTasks.rootId, rootId), eq(runtimeTasks.ownerId, ownerId)),
      )
      .orderBy(asc(runtimeTasks.createdSeq));
  }

  /** Inserts a task in `queued`. */
  async insert(tx: RuntimeTx, task: NewTaskRow): Promise<TaskRow> {
    const [row] = await tx
      .insert(runtimeTasks)
      .values({ ...task, status: TaskStatusSchema.enum.queued })
      .returning();
    return row;
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
