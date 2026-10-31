import { TaskStatusSchema, type TaskStatus } from '@agent-os/contracts';
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  type Database,
  researchTasks,
} from '@agent-os/db';

/** A transaction of the runtime; every data layer method takes one (ADR-0001). */
export type RuntimeTx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type TaskRow = typeof researchTasks.$inferSelect;

/** Statuses a task can leave; terminal statuses (`succeeded`, `failed`, `cancelled`) never change. */
export type UnfinishedTaskStatus = Extract<
  TaskStatus,
  'queued' | 'running' | 'waiting'
>;

const { queued, running, waiting, succeeded, failed, cancelled } =
  TaskStatusSchema.enum;

/** Transitions of the task state diagram (design-runtime.md, State Transitions and Invariants). */
const ALLOWED_TARGETS: Record<UnfinishedTaskStatus, readonly TaskStatus[]> = {
  queued: [running, cancelled, failed],
  running: [succeeded, failed, cancelled, waiting, queued],
  waiting: [queued, failed, cancelled],
};

/** Which row a guarded write may touch. */
export interface TaskGuard {
  taskId: string;
  /** Statuses the row must be in. */
  from: readonly UnfinishedTaskStatus[];
  /**
   * Fencing token: a `running` row matches only with this `attempt`. Required when `from`
   * includes `running`.
   */
  attempt?: number;
  /** Extra predicate, e.g. the reservation budget or an expired lease. */
  where?: SQL;
}

/** Contract, budget and identity columns never change; the guarded columns are set only here. */
type ImmutableColumn =
  | 'taskId'
  | 'investigationId'
  | 'workflowType'
  | 'workflowVersion'
  | 'input'
  | 'inputRefs'
  | 'expectedOutput'
  | 'dedupKey'
  | 'maxToolCalls'
  | 'maxRetries'
  | 'deadlineMs'
  | 'maxTokens'
  | 'createdAt';
type GuardedColumn =
  'status' | 'waitCondition' | 'stateVersion' | 'attempt' | 'deadlineAt';

/** Columns a guarded write may set freely (values or SQL over the row). */
export type TaskFields = Omit<
  PgUpdateSetSource<typeof researchTasks>,
  ImmutableColumn | GuardedColumn
>;

/** JSON object stored in `wait_condition`. */
export type WaitCondition = Readonly<Record<string, unknown>>;

export type TaskChange =
  /** `queued → running`: `attempt + 1` (only here), lease, `deadline_at` on the first claim only. */
  | {
      kind: 'claim';
      leaseOwner: string;
      leaseExpiresAt: Date;
      now: Date;
    }
  /** `running → waiting` with its condition (`waiting` ⇔ `wait_condition` not null). */
  | { kind: 'wait'; waitCondition: WaitCondition; fields?: TaskFields }
  /**
   * Any other write. With `status` the row leaves its status and `wait_condition` is cleared;
   * without it only `fields` change (heartbeat, reservation, checkpoint, cancel request).
   */
  | {
      kind: 'set';
      status?: Exclude<TaskStatus, 'running' | 'waiting'>;
      fields?: TaskFields;
    };

/**
 * Moves the attempt's counters into the task's (the write that ends an attempt: outcome,
 * `waiting`, regular return to `queued`). A lost attempt moves nothing.
 */
export const settleAttemptCounters: TaskFields = {
  toolCallsUsed: sql`${researchTasks.toolCallsUsed} + ${researchTasks.attemptToolCalls}`,
  retriesUsed: sql`${researchTasks.retriesUsed} + ${researchTasks.attemptRetries}`,
  attemptToolCalls: 0,
  attemptRetries: 0,
};

function targetStatus(change: TaskChange): TaskStatus | undefined {
  if (change.kind === 'claim') return running;
  if (change.kind === 'wait') return waiting;
  return change.status;
}

function assertAllowed(guard: TaskGuard, change: TaskChange): void {
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

function statusCondition(guard: TaskGuard): SQL | undefined {
  const others = guard.from.filter((status) => status !== running);
  const othersCondition =
    others.length > 0 ? inArray(researchTasks.status, others) : undefined;
  if (guard.attempt === undefined || !guard.from.includes(running)) {
    return othersCondition;
  }
  return or(
    and(
      eq(researchTasks.status, running),
      eq(researchTasks.attempt, guard.attempt),
    ),
    othersCondition,
  );
}

function changeColumns(
  change: TaskChange,
): PgUpdateSetSource<typeof researchTasks> {
  switch (change.kind) {
    case 'claim':
      return {
        status: running,
        attempt: sql`${researchTasks.attempt} + 1`,
        leaseOwner: change.leaseOwner,
        leaseExpiresAt: change.leaseExpiresAt,
        deadlineAt: sql`coalesce(${researchTasks.deadlineAt}, ${change.now}::timestamptz + ${researchTasks.deadlineMs} * interval '1 millisecond')`,
        startedAt: sql`coalesce(${researchTasks.startedAt}, ${change.now}::timestamptz)`,
        attemptToolCalls: 0,
        attemptRetries: 0,
      };
    case 'wait':
      return {
        ...change.fields,
        status: waiting,
        waitCondition: change.waitCondition,
      };
    case 'set':
      return change.status === undefined
        ? { ...change.fields }
        : { ...change.fields, status: change.status, waitCondition: null };
  }
}

/**
 * The only write of a `research_tasks` row (System Invariants): one UPDATE guarded by the
 * allowed source statuses and, for `running`, by the attempt; `state_version + 1`. Returns the
 * updated row, or `undefined` when the guard matched nothing (the write is fenced and dropped).
 */
export async function guardedTaskWrite(
  tx: RuntimeTx,
  guard: TaskGuard,
  change: TaskChange,
): Promise<TaskRow | undefined> {
  assertAllowed(guard, change);
  const [row] = await tx
    .update(researchTasks)
    .set({
      ...changeColumns(change),
      stateVersion: sql`${researchTasks.stateVersion} + 1`,
    })
    .where(
      and(
        eq(researchTasks.taskId, guard.taskId),
        statusCondition(guard),
        guard.where,
      ),
    )
    .returning();
  return row;
}
