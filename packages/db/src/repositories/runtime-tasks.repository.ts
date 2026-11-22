import { type TaskStatus, TaskStatusSchema, type WaitReason } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { Db } from '../db';
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
 * Drizzle queries of `runtime_tasks`. Task rows change only through {@link updateGuarded}, except the deletion mark of
 * {@link markDeleted}. A task with `deleted_at` answers as a missing one in
 * `findOwned` and `listTree`.
 */
@Injectable()
export class RuntimeTasksRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Whether the task row exists, deleted or not. */
  async exists(taskId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ taskId: runtimeTasks.taskId })
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, taskId));
    return rows.length > 0;
  }

  /** Every child of the given tasks, finished or not, in `task_id` order. */
  async listChildren(parentIds: readonly string[]): Promise<RuntimeTaskRow[]> {
    if (parentIds.length === 0) return [];
    return this.db.client
      .select()
      .from(runtimeTasks)
      .where(inArray(runtimeTasks.parentId, [...parentIds]))
      .orderBy(asc(runtimeTasks.taskId));
  }

  /** The owner's task; another owner's or a deleted one answers as a missing one. */
  async findOwned(
    taskId: string,
    ownerId: string,
  ): Promise<RuntimeTaskRow | undefined> {
    const [row] = await this.db.client
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
  listTree(rootId: string, ownerId: string): Promise<RuntimeTaskRow[]> {
    return this.db.client
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
   * Marks every task of the tree deleted (`stopTree`),
   * so the mark is not a guarded write: no step of the stopped tree can commit any more.
   */
  async markDeleted(rootId: string): Promise<void> {
    await this.db.client
      .update(runtimeTasks)
      .set({ deletedAt: sql`now()` })
      .where(eq(runtimeTasks.rootId, rootId));
  }

  /**
   * Inserts a task in `queued`. `undefined` when the id is already taken: the insert waits for a
   * concurrent one of the same id to commit and then writes nothing.
   */
  async insert(task: NewRuntimeTaskRow): Promise<RuntimeTaskRow | undefined> {
    const [row] = await this.db.client
      .insert(runtimeTasks)
      .values({ ...task, status: queued })
      .onConflictDoNothing({ target: runtimeTasks.taskId })
      .returning();
    return row;
  }

  /** The task, deleted or not. */
  async find(taskId: string): Promise<RuntimeTaskRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, taskId));
    return row;
  }

  /** The oldest `queued` task of the given types. */
  async findReady(types: readonly string[]): Promise<string | undefined> {
    const [ready] = await this.db.client
      .select({ taskId: runtimeTasks.taskId })
      .from(runtimeTasks)
      .where(and(eq(runtimeTasks.status, queued), inArray(runtimeTasks.type, [...types])))
      .orderBy(asc(runtimeTasks.createdAt), asc(runtimeTasks.taskId))
      .limit(1);
    return ready?.taskId;
  }

  /** `queued` and `running` tasks of the given types, the oldest first, at most `limit`. */
  listActive(
    types: readonly string[],
    limit: number,
  ): Promise<RuntimeTaskRow[]> {
    return this.db.client
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
    now: Date,
    limit: number,
  ): Promise<{ taskId: string; attempt: number }[]> {
    return this.db.client
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
    guard: RuntimeTaskRowGuard,
    columns: PgUpdateSetSource<typeof runtimeTasks>,
  ): Promise<RuntimeTaskRow | undefined> {
    const [row] = await this.db.client
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
