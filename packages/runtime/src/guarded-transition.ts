import {
  TaskStatusSchema,
  type TaskStatus,
  type WaitReason,
} from '@agent-os/contracts';
import { runtimeTasks } from '@agent-os/db';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { RuntimeTx } from './runtime-tx.js';

export type TaskRow = typeof runtimeTasks.$inferSelect;

const { queued, running, waiting, completed, failed, stopped } =
  TaskStatusSchema.enum;

/** Statuses that end a task; only a message with `revive` queues it again. */
const FINISHED_STATUSES: readonly TaskStatus[] = [
  completed,
  failed,
  stopped,
];

export const isFinished = (status: string): boolean =>
  (FINISHED_STATUSES as readonly string[]).includes(status);

/**
 * Transitions of the task state diagram (design-runtime.md, State Transitions and Invariants).
 * `queued → queued` and `waiting → waiting` are the interrupt of a task that is not running: the
 * status stays or changes its wait reason, and the attempt is fenced.
 */
const ALLOWED_TARGETS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: [queued, running, waiting, stopped],
  running: [queued, waiting, completed, failed, stopped],
  waiting: [queued, waiting, stopped],
  completed: [queued],
  failed: [queued],
  stopped: [queued],
};

/** Which row a guarded write may touch. */
export interface TaskGuard {
  taskId: string;
  /** Statuses the row must be in. */
  from: readonly TaskStatus[];
  /**
   * Fencing token: the row matches only with this `attempt`. Required when `from` includes
   * `running`, so that a step that is no longer current writes nothing (Invariant 1).
   */
  attempt?: number;
  /** Extra predicate, e.g. an expired lease or a wait reason. */
  where?: SQL;
}

/** Identity and input never change; the guarded columns are set only by {@link guardedTaskWrite}. */
type ImmutableColumn =
  | 'taskId'
  | 'type'
  | 'ownerId'
  | 'parentId'
  | 'rootId'
  | 'depth'
  | 'input'
  | 'createdAt';
type GuardedColumn =
  | 'status'
  | 'waitReason'
  | 'attempt'
  | 'updatedAt'
  | 'finishedAt';

/** Columns a guarded write may set freely (values or SQL over the row). */
export type TaskFields = Omit<
  PgUpdateSetSource<typeof runtimeTasks>,
  ImmutableColumn | GuardedColumn
>;

export type TaskChange =
  /** `queued → running`: `attempt + 1` and `step_claims + 1` (only here), the lease. */
  | { kind: 'claim'; leaseExpiresAt: Date }
  /** → `waiting` with its reason (`waiting` ⇔ `wait_reason` not null). */
  | {
      kind: 'wait';
      reason: WaitReason;
      fields?: TaskFields;
      /** `attempt + 1`: the step in flight, if any, is no longer current. */
      fence?: boolean;
    }
  /**
   * Any other write. With `status` the row leaves its status, `wait_reason` and the lease are
   * cleared and `finished_at` follows the status; without it only `fields` change (heartbeat).
   */
  | {
      kind: 'set';
      status?: Exclude<TaskStatus, 'running' | 'waiting'>;
      fields?: TaskFields;
      /** `attempt + 1`: the step in flight, if any, is no longer current. */
      fence?: boolean;
    };

function targetStatus(change: TaskChange): TaskStatus | undefined {
  if (change.kind === 'claim') return running;
  if (change.kind === 'wait') return waiting;
  return change.status;
}

function assertAllowed(guard: TaskGuard, change: TaskChange): void {
  if (guard.from.length === 0) {
    throw new Error(`Guarded write of task ${guard.taskId} has no source status`);
  }
  if (guard.from.includes(running) && guard.attempt === undefined) {
    throw new Error(
      `Guarded write of running task ${guard.taskId} needs its attempt`,
    );
  }
  const target = targetStatus(change);
  if (target === undefined) return;
  const illegal = guard.from.filter(
    (from) => !ALLOWED_TARGETS[from].includes(target),
  );
  if (illegal.length > 0) {
    throw new Error(
      `Illegal task transition ${illegal.join(', ')} → ${target} (task ${guard.taskId})`,
    );
  }
}

const nextAttempt = sql`${runtimeTasks.attempt} + 1`;

/** Columns that follow a new status: no wait reason, no lease, `finished_at` only when finished. */
function leaveStatus(
  status: TaskStatus,
): PgUpdateSetSource<typeof runtimeTasks> {
  return {
    status,
    waitReason: null,
    leaseExpiresAt: null,
    finishedAt: isFinished(status) ? sql`now()` : null,
  };
}

function changeColumns(
  change: TaskChange,
): PgUpdateSetSource<typeof runtimeTasks> {
  switch (change.kind) {
    case 'claim':
      return {
        status: running,
        attempt: nextAttempt,
        stepClaims: sql`${runtimeTasks.stepClaims} + 1`,
        leaseExpiresAt: change.leaseExpiresAt,
      };
    case 'wait':
      return {
        ...change.fields,
        ...leaveStatus(waiting),
        waitReason: change.reason,
        ...(change.fence ? { attempt: nextAttempt } : {}),
      };
    case 'set':
      return {
        ...change.fields,
        ...(change.status === undefined ? {} : leaveStatus(change.status)),
        ...(change.fence ? { attempt: nextAttempt } : {}),
      };
  }
}

/**
 * The only write of a `runtime_tasks` row: one UPDATE guarded by the allowed source statuses and,
 * when given, by the attempt (fencing, ADR-0001). Returns the updated row, or `undefined` when the
 * guard matched nothing — the write is fenced and dropped.
 */
export async function guardedTaskWrite(
  tx: RuntimeTx,
  guard: TaskGuard,
  change: TaskChange,
): Promise<TaskRow | undefined> {
  assertAllowed(guard, change);
  const [row] = await tx
    .update(runtimeTasks)
    .set({ ...changeColumns(change), updatedAt: sql`now()` })
    .where(
      and(
        eq(runtimeTasks.taskId, guard.taskId),
        inArray(runtimeTasks.status, [...guard.from]),
        guard.attempt === undefined
          ? undefined
          : eq(runtimeTasks.attempt, guard.attempt),
        guard.where,
      ),
    )
    .returning();
  return row;
}
