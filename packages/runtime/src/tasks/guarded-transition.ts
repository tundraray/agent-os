import {
  TaskStatusSchema,
  type TaskStatus,
  type WaitReason,
} from '@agent-os/contracts';
import type { runtimeTasks } from '@agent-os/db';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

export type TaskRow = typeof runtimeTasks.$inferSelect;

/** Why a failed task failed: a runtime reason (`handler_error`, …) or the upper layer's own. */
export interface TaskFailure {
  reason: string;
  message: string;
}

const { queued, running, waiting, completed, failed, stopped } =
  TaskStatusSchema.enum;

/** Statuses that end a task; only a message with `revive` queues it again. */
const FINISHED_STATUSES: readonly TaskStatus[] = [completed, failed, stopped];

/** Statuses of a task that has not ended. */
export const UNFINISHED_STATUSES: readonly TaskStatus[] = [
  queued,
  running,
  waiting,
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
  /** The row matches only while it waits for this reason. */
  waitReason?: WaitReason;
}

/** Identity and input never change; the guarded columns are set only by `Tasks.transition`. */
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
  'status' | 'waitReason' | 'attempt' | 'updatedAt' | 'finishedAt';

/** Columns a guarded write may set freely (values or SQL over the row). */
export type TaskFields = Omit<
  PgUpdateSetSource<typeof runtimeTasks>,
  ImmutableColumn | GuardedColumn
>;

export type TaskChange =
  /** `queued → running`: `attempt + 1` and `step_claims + 1` (only here). */
  | { kind: 'claim' }
  /** → `waiting` with its reason (`waiting` ⇔ `wait_reason` not null). */
  | {
      kind: 'wait';
      reason: WaitReason;
      fields?: TaskFields;
      /** `attempt + 1`: the step in flight, if any, is no longer current. */
      fence?: boolean;
    }
  /**
   * Any other write. With `status` the row leaves its status, `wait_reason` is cleared and
   * `finished_at` follows the status; without it only `fields` change.
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

/** Throws on a guarded write the state diagram forbids or one of a running task without its attempt. */
export function assertAllowed(guard: TaskGuard, change: TaskChange): void {
  if (guard.from.length === 0) {
    throw new Error(
      `Guarded write of task ${guard.taskId} has no source status`,
    );
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
