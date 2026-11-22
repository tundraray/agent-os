import { TaskStatusSchema } from '@agent-os/contracts';
import { runtimeTasks } from '@agent-os/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { RuntimeError } from './errors';
import {
  guardedTaskWrite,
  type TaskChange,
  type TaskGuard,
  type TaskRow,
} from './guarded-transition';
import type { RuntimeTx } from './runtime-tx';

export type NewTaskRow = Pick<
  typeof runtimeTasks.$inferInsert,
  'taskId' | 'type' | 'ownerId' | 'parentId' | 'rootId' | 'depth' | 'input' | 'trackerId'
>;

/**
 * Drizzle queries of `runtime_tasks` inside the caller's transaction (repository over a
 * transaction). Lock order: a parent before its children, tasks of one level by `task_id`. Task
 * rows change only through {@link guardedTaskWrite}, except the deletion mark of
 * {@link markDeleted}. A task with `deleted_at` answers as a missing one in `lockOwned`,
 * `findOwned` and `listTree`.
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

  /**
   * Locks the owner's task FOR UPDATE; another owner's task and a task of a deleted tree are as
   * absent as a missing one. The flag is read under the row lock, and this is the lock every
   * external message takes (`inbox.insertMessage`, the only revival from outside): a send that
   * waited for the lock of a root being deleted reads the committed flag and is refused, so it
   * cannot wake the deleted tree. The check must stay here, not move up into a caller.
   */
  async lockOwned(
    tx: RuntimeTx,
    taskId: string,
    ownerId: string,
  ): Promise<TaskRow | undefined> {
    const row = await this.lock(tx, taskId);
    return row?.ownerId === ownerId && row.deletedAt === null ? row : undefined;
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

  /** The owner's task without a lock; another owner's or a deleted one answers as a missing one. */
  async findOwned(
    tx: RuntimeTx,
    taskId: string,
    ownerId: string,
  ): Promise<TaskRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeTasks)
      .where(
        and(
          eq(runtimeTasks.taskId, taskId),
          eq(runtimeTasks.ownerId, ownerId),
          isNull(runtimeTasks.deletedAt),
        ),
      );
    return row;
  }

  /** Every task of the owner's tree in creation order; `[]` for another's, deleted or no tree. */
  listTree(tx: RuntimeTx, rootId: string, ownerId: string): Promise<TaskRow[]> {
    return tx
      .select()
      .from(runtimeTasks)
      .where(
        and(
          eq(runtimeTasks.rootId, rootId),
          eq(runtimeTasks.ownerId, ownerId),
          isNull(runtimeTasks.deletedAt),
        ),
      )
      .orderBy(asc(runtimeTasks.createdSeq));
  }

  /**
   * Marks every task of the tree deleted. The caller holds the lock of each of them (`stopTree`),
   * so the mark is not a guarded write: no step of the stopped tree can commit any more.
   */
  async markDeleted(tx: RuntimeTx, rootId: string): Promise<void> {
    await tx
      .update(runtimeTasks)
      .set({ deletedAt: sql`now()` })
      .where(eq(runtimeTasks.rootId, rootId));
  }

  /**
   * Inserts a task in `queued`. An id already taken is `TASK_EXISTS`: the insert waits for a
   * concurrent one of the same id to commit and then writes nothing.
   */
  async insert(tx: RuntimeTx, task: NewTaskRow): Promise<TaskRow> {
    const [row] = await tx
      .insert(runtimeTasks)
      .values({ ...task, status: TaskStatusSchema.enum.queued })
      .onConflictDoNothing({ target: runtimeTasks.taskId })
      .returning();
    if (row === undefined) {
      throw new RuntimeError('TASK_EXISTS', `Task ${task.taskId} exists`);
    }
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
