import {
  type FailureClass,
  type FailureReason,
  RuntimeEventTypeSchema,
  TaskEdgeKindSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { and, asc, eq, inArray, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { RuntimeLogger } from './ports.js';
import type { RuntimeConfig } from './runtime-config.js';
import {
  type Database,
  researchTaskDependencies,
  researchTasks,
} from '@agent-os/db';
import type { Clock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import {
  CANCEL_REQUESTED_FAILURE,
  CANCELLED_EVENT_PAYLOAD,
} from './dispatcher.js';
import { EventLog } from './event-log.js';
import type {
  RuntimeTx,
  TaskFields,
  TaskGuard,
  TaskRow,
} from './guarded-transition.js';
import { WorkerLoop } from './outbox.relay.js';
import { queueLimitMs } from './task-limits.js';
import { TaskRepository } from './task.repository.js';

const { queued, running, waiting, succeeded, failed, cancelled } =
  TaskStatusSchema.enum;
const { TaskQueued, TaskFailed, TaskCancelled } = RuntimeEventTypeSchema.enum;
const { depends_on } = TaskEdgeKindSchema.enum;

/** Tasks taken by one query of a pass. */
const SWEEP_BATCH = 50;

/** Reasons the reaper ends a task with, by code; class `cancelled` ends it with status `cancelled`. */
type ReaperFailure =
  | 'cancel_requested'
  | 'deadline_exceeded'
  | 'queue_wait_exceeded'
  | 'recovery_exhausted';

/** What the reaper writes for a task: back to `queued`, or an end with a runtime reason. */
type Verdict = { kind: 'requeue' } | { kind: 'fail'; reason: ReaperFailure };

const FAILURES: Record<
  ReaperFailure,
  {
    class: Extract<FailureClass, 'cancelled' | 'deadline' | 'recovery_exhausted'>;
    code: ReaperFailure;
    message: string;
  }
> = {
  cancel_requested: CANCEL_REQUESTED_FAILURE,
  deadline_exceeded: {
    class: 'deadline',
    code: 'deadline_exceeded',
    message: 'The task ran past its deadline',
  },
  queue_wait_exceeded: {
    class: 'deadline',
    code: 'queue_wait_exceeded',
    message: 'The task waited in the queue past its limit',
  },
  recovery_exhausted: {
    class: 'recovery_exhausted',
    code: 'recovery_exhausted',
    message: 'Every attempt of the task was lost or ran past its limit',
  },
};

/**
 * Readiness of a `research_tasks` row (the dispatcher's readiness query, Data Model): no
 * `depends_on` edge to a task that has not succeeded. Raw SQL, as it is used both in a select and
 * in the guarded update, where the task table cannot be aliased.
 */
const DEPENDENCIES_SUCCEEDED = sql`not exists (
  select 1 from ${researchTaskDependencies} edge
    join ${researchTasks} dependency on dependency.task_id = edge.depends_on_task_id
   where edge.task_id = "research_tasks"."task_id" and edge.kind = ${depends_on}
     and dependency.status <> ${succeeded})`;

/**
 * The moment a ready task became ready (KD-3, Data Model): its creation, or the latest end of its
 * `depends_on` dependencies when later (`greatest` skips the NULL of a task without any).
 */
const READY_AT = sql`greatest("research_tasks"."created_at", (
  select max(dependency.finished_at) from ${researchTaskDependencies} edge
    join ${researchTasks} dependency on dependency.task_id = edge.depends_on_task_id
   where edge.task_id = "research_tasks"."task_id" and edge.kind = ${depends_on}))`;

/** A ready task never claimed (attempt 0) that became ready at or before `readySince`. */
function readyAndUnclaimedSince(readySince: SQL): SQL | undefined {
  return and(
    eq(researchTasks.attempt, 0),
    DEPENDENCIES_SUCCEEDED,
    sql`${READY_AT} <= ${readySince}`,
  );
}

/**
 * Recovery of tasks left behind (Flow 3), every `RUNTIME_REAPER_MS`. A `running` task whose lease
 * has expired — its worker is gone, or the dispatcher expired it when the attempt ran past
 * `RUNTIME_ATTEMPT_MS` (KD-3, Flow 4 of design-lifecycle.md) — returns to `queued` with `recovery_count + 1`
 * (`TaskQueued (recovered)`), so that a new attempt runs it (ADR-0001: a retry is only a runtime
 * attempt after recovery); past its deadline it is `failed` with class `deadline`, and once
 * `RUNTIME_MAX_RECOVERIES` are spent with `recovery_exhausted` (AC-RT-2); with `cancel_requested_at`
 * set — its investigation was cancelled while it ran — it is `cancelled` (Flow 4). A `queued` or `waiting`
 * task past its deadline is `failed` with class `deadline` (AC-19.2). A ready task never claimed
 * that waited past its queue limit is `failed` with class `deadline` and code `queue_wait_exceeded`
 * (KD-3, AC-20.1). No handler is called; each task is one transaction that writes its guarded row
 * first, then its event.
 */
export class RecoverySweeper {
  private readonly loop: WorkerLoop;

  constructor(
    private readonly db: Database,
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly logger: RuntimeLogger,
    private readonly tasks: TaskRepository,
    private readonly events: EventLog,
    private readonly crashPoints: CrashPoints,
  ) {
    this.loop = new WorkerLoop({
      name: 'reaper',
      periodMs: config.reaperMs,
      pollMs: config.pollMs,
      clock,
      logger: this.logger,
      pass: () => this.sweep(),
    });
  }

  start(): void {
    this.loop.start();
  }

  shutdown(): Promise<void> {
    return this.loop.stop();
  }

  /** One pass; `true` when a batch of any of its queries was full and more may be left. */
  private async sweep(): Promise<boolean> {
    const now = this.clock.now();
    const passes: [
      find: (now: Date) => Promise<TaskRow[]>,
      handle: (task: TaskRow, now: Date) => Promise<void>,
    ][] = [
      [(at) => this.expiredLeases(at), (task, at) => this.recover(task, at)],
      [(at) => this.overdue(at), (task, at) => this.expire(task, at)],
      [
        (at) => this.pastQueueLimit(at),
        (task, at) => this.expireQueueWait(task, at),
      ],
    ];
    let more = false;
    for (const [find, handle] of passes) {
      const batch = await find(now);
      for (const task of batch) await handle(task, now);
      more ||= batch.length === SWEEP_BATCH;
    }
    return more;
  }

  private expiredLeases(now: Date): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.status, running),
          lt(researchTasks.leaseExpiresAt, now),
        ),
      )
      .orderBy(asc(researchTasks.leaseExpiresAt))
      .limit(SWEEP_BATCH);
  }

  private overdue(now: Date): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(researchTasks)
      .where(
        and(
          inArray(researchTasks.status, [queued, waiting]),
          lte(researchTasks.deadlineAt, now),
        ),
      )
      .orderBy(asc(researchTasks.deadlineAt))
      .limit(SWEEP_BATCH);
  }

  /**
   * Ready tasks never claimed whose queue limit has passed. The limit is applied here in SQL too,
   * so that a batch is not filled by tasks still within it; the write of each task decides by
   * {@link queueLimitMs}.
   */
  private pastQueueLimit(now: Date): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.status, queued),
          readyAndUnclaimedSince(
            sql`(${now}::timestamptz - least(${this.config.queueWaitMs}::integer,
              "research_tasks"."deadline_ms") * interval '1 millisecond')`,
          ),
        ),
      )
      .orderBy(asc(researchTasks.createdAt))
      .limit(SWEEP_BATCH);
  }

  /** `cancel_requested_at` turns any end into `cancelled` (Data Contract, итог попытки). */
  private verdictOf(task: TaskRow, now: Date): Verdict {
    if (task.cancelRequestedAt !== null) {
      return { kind: 'fail', reason: 'cancel_requested' };
    }
    if (task.deadlineAt !== null && task.deadlineAt <= now) {
      return { kind: 'fail', reason: 'deadline_exceeded' };
    }
    if (task.recoveryCount >= this.config.maxRecoveries) {
      return { kind: 'fail', reason: 'recovery_exhausted' };
    }
    return { kind: 'requeue' };
  }

  /**
   * A `running` task with an expired lease, guarded by its attempt and the expiry: a heartbeat
   * that extended the lease meanwhile, or another reaper, makes this write 0 rows.
   */
  private async recover(task: TaskRow, now: Date): Promise<void> {
    const verdict = this.verdictOf(task, now);
    const context = `investigationId=${task.investigationId} taskId=${task.taskId} attempt=${task.attempt}`;
    const written = await this.db.transaction(async (tx) => {
      const guard: TaskGuard = {
        taskId: task.taskId,
        from: [running],
        attempt: task.attempt,
        where: lt(researchTasks.leaseExpiresAt, now),
      };
      // The lost attempt's counters are not settled (Data Contract): the next claim resets them.
      const releaseLease: TaskFields = {
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      if (verdict.kind === 'requeue') {
        const row = await this.tasks.transition(tx, guard, {
          kind: 'set',
          status: queued,
          fields: {
            ...releaseLease,
            recoveryCount: sql`${researchTasks.recoveryCount} + 1`,
          },
        });
        if (!row) return undefined;
        await this.appendEvent(tx, row, TaskQueued, { reason: 'recovered' });
        return row;
      }
      return this.writeFailure(
        tx,
        guard,
        task,
        verdict.reason,
        releaseLease,
      );
    });
    if (!written) return;
    if (verdict.kind === 'requeue') {
      this.logger.warn(
        `recovered, lease expired ${context} recoveryCount=${written.recoveryCount}`,
      );
      this.crashPoints.hit('reaper.after-requeue');
      return;
    }
    this.logger.warn(
      `lease expired, failed ${context} code=${verdict.reason}`,
    );
  }

  /** A `queued` or `waiting` task past its deadline. */
  private expire(task: TaskRow, now: Date): Promise<void> {
    return this.failUnclaimed(
      task,
      { from: [queued, waiting], where: lte(researchTasks.deadlineAt, now) },
      'deadline_exceeded',
    );
  }

  /**
   * A ready task never claimed, past its queue limit counted from the moment it became ready.
   * Guarded by the same condition: a claim by a dispatcher meanwhile (`running`, attempt 1), or
   * another reaper, makes this write 0 rows.
   */
  private expireQueueWait(task: TaskRow, now: Date): Promise<void> {
    const limitMs = queueLimitMs(this.config.queueWaitMs, task.deadlineMs);
    return this.failUnclaimed(
      task,
      {
        from: [queued],
        where: readyAndUnclaimedSince(
          sql`${new Date(now.getTime() - limitMs)}::timestamptz`,
        ),
      },
      'queue_wait_exceeded',
    );
  }

  /** Ends a task no attempt holds with `reason`, under `guard`. */
  private async failUnclaimed(
    task: TaskRow,
    guard: Omit<TaskGuard, 'taskId'>,
    reason: ReaperFailure,
  ): Promise<void> {
    const written = await this.db.transaction((tx) =>
      this.writeFailure(tx, { ...guard, taskId: task.taskId }, task, reason, {}),
    );
    if (written) {
      this.logger.warn(
        `limit passed, failed investigationId=${task.investigationId} taskId=${task.taskId} attempt=${task.attempt} code=${reason}`,
      );
    }
  }

  private async writeFailure(
    tx: RuntimeTx,
    guard: TaskGuard,
    task: TaskRow,
    reason: ReaperFailure,
    fields: TaskFields,
  ): Promise<TaskRow | undefined> {
    const failure: FailureReason = {
      ...FAILURES[reason],
      cause: null,
      attempt: task.attempt,
      toolCalls: task.attemptToolCalls,
      retries: task.attemptRetries,
    };
    const isCancel = failure.class === 'cancelled';
    const row = await this.tasks.transition(tx, guard, {
      kind: 'set',
      status: isCancel ? cancelled : failed,
      fields: {
        ...fields,
        failureReason: failure,
        finishedAt: this.clock.now(),
      },
    });
    if (!row) return undefined;
    if (isCancel) {
      await this.appendEvent(tx, row, TaskCancelled, CANCELLED_EVENT_PAYLOAD);
    } else {
      await this.appendEvent(tx, row, TaskFailed, {
        attempt: row.attempt,
        failureClass: failure.class,
        code: failure.code,
      });
    }
    return row;
  }

  private async appendEvent(
    tx: RuntimeTx,
    row: TaskRow,
    type: typeof TaskQueued | typeof TaskFailed | typeof TaskCancelled,
    payload: Record<string, string | number | null>,
  ): Promise<void> {
    await this.events.append(tx, {
      type,
      investigationId: row.investigationId,
      taskId: row.taskId,
      // Like every event ending an attempt: after its latest EvidenceStored or TaskStarted.
      causationId: await this.events.causeOf(tx, {
        type: TaskFailed,
        taskId: row.taskId,
      }),
      stateRevision: row.stateVersion,
      payload,
    });
  }
}
