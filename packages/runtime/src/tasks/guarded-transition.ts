import {
  TaskStatusSchema,
  type TaskStatus,
  type WaitReason,
} from '@agent-os/contracts';
import type { RuntimeTaskRowGuard, RuntimeTaskWrite } from '@agent-os/db';

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

/** Plain column values a change may set besides its status and counters. */
export type TaskValues = Pick<
  RuntimeTaskWrite,
  'stepNo' | 'stepClaims' | 'recoveries' | 'result' | 'failure'
>;

export type TaskChange =
  /** `queued → running`: `attempt + 1` and `step_claims + 1` (only here). */
  | { kind: 'claim' }
  /** → `waiting` with its reason (`waiting` ⇔ `wait_reason` not null). */
  | {
      kind: 'wait';
      reason: WaitReason;
      fields?: TaskValues;
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
      fields?: TaskValues;
      /** `attempt + 1`: the step in flight, if any, is no longer current. */
      fence?: boolean;
    };

function targetStatus(change: TaskChange): TaskStatus | undefined {
  if (change.kind === 'claim') return running;
  if (change.kind === 'wait') return waiting;
  return change.status;
}

/**
 * Throws on a guarded write the state diagram forbids or one of a running task without its attempt:
 * the attempt is the fencing token, so a step that is no longer current writes nothing (Invariant 1).
 */
export function assertAllowed(
  guard: RuntimeTaskRowGuard,
  change: TaskChange,
): void {
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
