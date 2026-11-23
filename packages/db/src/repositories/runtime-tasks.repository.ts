import {
  type TaskStatus,
  TaskStatusSchema,
  type WaitReason,
} from '@agent-os/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db';
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

/**
 * The closed set of a guarded write: the runtime says what changes, this repository builds the SQL.
 * An empty set holds the row (`updated_at` only).
 */
export interface RuntimeTaskWrite {
  /**
   * The new status. With it `wait_reason` becomes `waitReason` (null without one) and `finished_at`
   * becomes `now()` with `finishedNow`, null without it.
   */
  status?: TaskStatus;
  waitReason?: WaitReason;
  finishedNow?: boolean;
  /** `attempt + 1`: the step in flight, if any, is no longer current. */
  nextAttempt?: boolean;
  stepNo?: number;
  recoveries?: number;
  result?: unknown;
  failure?: unknown;
}

function writeColumns(
  write: RuntimeTaskWrite,
): PgUpdateSetSource<typeof runtimeTasks> {
  const { status, waitReason, finishedNow, nextAttempt, ...values } = write;
  return {
    ...values,
    ...(status !== undefined && {
      status,
      waitReason: waitReason ?? null,
      finishedAt: finishedNow ? sql`now()` : null,
    }),
    ...(nextAttempt && { attempt: sql`${runtimeTasks.attempt} + 1` }),
  };
}

const { queued, running, waiting } = TaskStatusSchema.enum;

export type NewRuntimeTaskRow = Pick<
  typeof runtimeTasks.$inferInsert,
  | 'taskId'
  | 'type'
  | 'ownerId'
  | 'parentId'
  | 'rootId'
  | 'depth'
  | 'input'
  | 'awaitedStep'
>;

/**
 * Drizzle queries of `runtime_tasks`. Task rows change only through {@link updateGuarded}, except the deletion mark of
 * {@link markDeleted}. A task with `deleted_at` answers as a missing one in
 * `findOwned` and `listTree`.
 */
export class RuntimeTasksRepository {
  constructor(private readonly db: Db) {}

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

  /**
   * How many children of the parent with `awaited_step` = `stepNo` are unfinished (KD-2): the
   * children the parent waits for when its `step_no` is `stepNo`.
   */
  async countUnfinishedAwaited(
    parentId: string,
    stepNo: number,
  ): Promise<number> {
    const [row] = await this.db.client
      .select({ count: sql<number>`count(*)::int` })
      .from(runtimeTasks)
      .where(
        and(
          eq(runtimeTasks.parentId, parentId),
          eq(runtimeTasks.awaitedStep, stepNo),
          inArray(runtimeTasks.status, [queued, running, waiting]),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * The owner's task; another owner's or a deleted one answers as a missing one. A `null` owner finds only a task
   * of the platform's own work: the runtime passes it for a message between such tasks, an employee never has it.
   */
  async findOwned(
    taskId: string,
    ownerId: string | null,
  ): Promise<RuntimeTaskRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(runtimeTasks)
      .where(
        and(
          eq(runtimeTasks.taskId, taskId),
          ownerId === null
            ? isNull(runtimeTasks.ownerId)
            : eq(runtimeTasks.ownerId, ownerId),
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

  /** The oldest `queued` task of the given types outside a deleted tree. */
  async findReady(types: readonly string[]): Promise<string | undefined> {
    const [ready] = await this.db.client
      .select({ taskId: runtimeTasks.taskId })
      .from(runtimeTasks)
      .where(
        and(
          eq(runtimeTasks.status, queued),
          inArray(runtimeTasks.type, [...types]),
          // A task of a deleted tree is never claimed, even one a message revived during the deletion.
          isNull(runtimeTasks.deletedAt),
        ),
      )
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
        and(
          inArray(runtimeTasks.status, [queued, running]),
          inArray(runtimeTasks.type, [...types]),
        ),
      )
      .orderBy(asc(runtimeTasks.createdAt), asc(runtimeTasks.taskId))
      .limit(limit);
  }

  /** Every `running` task of the given types with the attempt that claimed it. */
  listRunning(
    types: readonly string[],
  ): Promise<{ taskId: string; attempt: number }[]> {
    return this.db.client
      .select({ taskId: runtimeTasks.taskId, attempt: runtimeTasks.attempt })
      .from(runtimeTasks)
      .where(
        and(
          eq(runtimeTasks.status, running),
          inArray(runtimeTasks.type, [...types]),
        ),
      );
  }

  /**
   * The only write of a `runtime_tasks` row besides {@link insert} and {@link markDeleted}: one UPDATE of the columns of `write` and `updated_at`, guarded by the
   * allowed source statuses and, when given, by the attempt (fencing, ADR-0001) and the wait reason. Returns the updated row, or `undefined`
   * when the guard matched nothing — the write is fenced and dropped. Which columns a change sets
   * and which changes are allowed is the rule of the runtime's `Tasks`, the only caller.
   */
  async updateGuarded(
    guard: RuntimeTaskRowGuard,
    write: RuntimeTaskWrite,
  ): Promise<RuntimeTaskRow | undefined> {
    const [row] = await this.db.client
      .update(runtimeTasks)
      .set({ ...writeColumns(write), updatedAt: sql`now()` })
      .where(
        and(
          eq(runtimeTasks.taskId, guard.taskId),
          inArray(runtimeTasks.status, [...guard.from]),
          guard.attempt === undefined
            ? undefined
            : eq(runtimeTasks.attempt, guard.attempt),
          guard.waitReason === undefined
            ? undefined
            : eq(runtimeTasks.waitReason, guard.waitReason),
        ),
      )
      .returning();
    return row;
  }

  /**
   * `pg_notify` of the tree in the open transaction, data `{"rootId"}`: listeners get it when the
   * transaction commits, and Postgres folds equal notifications of one transaction into one.
   */
  async notify(channel: string, rootId: string): Promise<void> {
    const payload = JSON.stringify({ rootId });
    await this.db.client.execute(sql`select pg_notify(${channel}, ${payload})`);
  }
}
