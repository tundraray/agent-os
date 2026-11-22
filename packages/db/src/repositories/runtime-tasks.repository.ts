import { type TaskStatus, TaskStatusSchema, type WaitReason } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Executor, Transaction } from '../database';
import { runtimeTasks } from '../schema';

export type RuntimeTaskRow = typeof runtimeTasks.$inferSelect;

/** Which row {@link RuntimeTasksRepository.updateGuarded} may touch. */
export interface RuntimeTaskRowGuard {
  taskId: string;
  /** Statuses the row must be in. */
  from: readonly TaskStatus[];
  /** The row matches only with this `attempt`. */
  attempt?: number;
  /** The row matches only while it waits for this reason. */
  waitReason?: WaitReason;
}

const { queued, running } = TaskStatusSchema.enum;

export type NewRuntimeTaskRow = Pick<
  typeof runtimeTasks.$inferInsert,
  'taskId' | 'type' | 'ownerId' | 'parentId' | 'rootId' | 'depth' | 'input' | 'trackerId'
>;

/**
 * Drizzle queries of `runtime_tasks` inside the caller's transaction (repository over a
 * transaction). Lock order: a parent before its children, tasks of one level by `task_id`. Task
 * rows change only through {@link updateGuarded}, except the deletion mark of
 * {@link markDeleted}. A task with `deleted_at` answers as a missing one in `lockOwned`,
 * `findOwned` and `listTree`.
 */
@Injectable()
export class RuntimeTasksRepository {
  /** Locks the task FOR UPDATE. */
  async lock(tx: Transaction, taskId: string): Promise<RuntimeTaskRow | undefined> {
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
  async lockAgainstDelete(tx: Transaction, taskId: string): Promise<boolean> {
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
    tx: Transaction,
    taskId: string,
    ownerId: string,
  ): Promise<RuntimeTaskRow | undefined> {
    const row = await this.lock(tx, taskId);
    return row?.ownerId === ownerId && row.deletedAt === null ? row : undefined;
  }

  /**
   * Locks the task's parent FOR UPDATE, then the task: the lock of a write that may end the task,
   * whose end notice goes to the parent. A parent before its children in every transaction keeps
   * an ending child and a stop of its parent from deadlocking (plan Notes 4, Invariant 6).
   */
  async lockWithParent(tx: Transaction, taskId: string): Promise<RuntimeTaskRow | undefined> {
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
  async lockChildren(tx: Transaction, parentIds: readonly string[]): Promise<RuntimeTaskRow[]> {
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
    tx: Transaction,
    taskId: string,
    ownerId: string,
  ): Promise<RuntimeTaskRow | undefined> {
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
  listTree(tx: Transaction, rootId: string, ownerId: string): Promise<RuntimeTaskRow[]> {
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
  async markDeleted(tx: Transaction, rootId: string): Promise<void> {
    await tx
      .update(runtimeTasks)
      .set({ deletedAt: sql`now()` })
      .where(eq(runtimeTasks.rootId, rootId));
  }

  /**
   * Inserts a task in `queued`. `undefined` when the id is already taken: the insert waits for a
   * concurrent one of the same id to commit and then writes nothing.
   */
  async insert(tx: Transaction, task: NewRuntimeTaskRow): Promise<RuntimeTaskRow | undefined> {
    const [row] = await tx
      .insert(runtimeTasks)
      .values({ ...task, status: queued })
      .onConflictDoNothing({ target: runtimeTasks.taskId })
      .returning();
    return row;
  }

  /** The task without a lock, deleted or not. */
  async find(executor: Executor, taskId: string): Promise<RuntimeTaskRow | undefined> {
    const [row] = await executor
      .select()
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, taskId));
    return row;
  }

  /** Locks the oldest `queued` task of the given types, skipping rows other claims hold. */
  async lockReady(tx: Transaction, types: readonly string[]): Promise<string | undefined> {
    const [ready] = await tx
      .select({ taskId: runtimeTasks.taskId })
      .from(runtimeTasks)
      .where(and(eq(runtimeTasks.status, queued), inArray(runtimeTasks.type, [...types])))
      .orderBy(asc(runtimeTasks.createdAt), asc(runtimeTasks.taskId))
      .limit(1)
      .for('update', { skipLocked: true });
    return ready?.taskId;
  }

  /** `queued` and `running` tasks of the given types, the oldest first, at most `limit`. */
  listActive(
    executor: Executor,
    types: readonly string[],
    limit: number,
  ): Promise<RuntimeTaskRow[]> {
    return executor
      .select()
      .from(runtimeTasks)
      .where(
        and(inArray(runtimeTasks.status, [queued, running]), inArray(runtimeTasks.type, [...types])),
      )
      .orderBy(asc(runtimeTasks.createdAt), asc(runtimeTasks.taskId))
      .limit(limit);
  }

  /** `running` tasks whose lease ran out before `now`, the oldest lease first, at most `limit`. */
  listExpired(
    executor: Executor,
    now: Date,
    limit: number,
  ): Promise<{ taskId: string; attempt: number }[]> {
    return executor
      .select({ taskId: runtimeTasks.taskId, attempt: runtimeTasks.attempt })
      .from(runtimeTasks)
      .where(and(eq(runtimeTasks.status, running), lt(runtimeTasks.leaseExpiresAt, now)))
      .orderBy(asc(runtimeTasks.leaseExpiresAt))
      .limit(limit);
  }

  /**
   * The only write of a `runtime_tasks` row besides {@link insert} and {@link markDeleted}: one
   * UPDATE of `columns` and `updated_at`, guarded by the allowed source statuses and, when given,
   * by the attempt (fencing, ADR-0001) and the wait reason. Returns the updated row, or `undefined`
   * when the guard matched nothing — the write is fenced and dropped. Which columns a change sets
   * and which changes are allowed is the rule of the runtime's `Tasks.transition`, the only caller.
   */
  async updateGuarded(
    tx: Transaction,
    guard: RuntimeTaskRowGuard,
    columns: PgUpdateSetSource<typeof runtimeTasks>,
  ): Promise<RuntimeTaskRow | undefined> {
    const [row] = await tx
      .update(runtimeTasks)
      .set({ ...columns, updatedAt: sql`now()` })
      .where(
        and(
          eq(runtimeTasks.taskId, guard.taskId),
          inArray(runtimeTasks.status, [...guard.from]),
          guard.attempt === undefined ? undefined : eq(runtimeTasks.attempt, guard.attempt),
          guard.waitReason === undefined
            ? undefined
            : eq(runtimeTasks.waitReason, guard.waitReason),
        ),
      )
      .returning();
    return row;
  }
}
