import {
  type FailureClass,
  type FailureReason,
  RuntimeEventTypeSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { RuntimeLogger } from './ports.js';
import type { RuntimeConfig } from './runtime-config.js';
import {
  type Database,
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
import { TaskRepository } from './task.repository.js';

const { queued, running, waiting, failed, cancelled } = TaskStatusSchema.enum;
const { TaskQueued, TaskFailed, TaskCancelled } = RuntimeEventTypeSchema.enum;

/** Tasks taken by one query of a pass. */
const SWEEP_BATCH = 50;

/** Classes the reaper ends a task with; `cancelled` ends it with status `cancelled`. */
type ReaperFailureClass = Extract<
  FailureClass,
  'cancelled' | 'deadline' | 'recovery_exhausted'
>;

/** What the reaper writes for a task: back to `queued`, or an end with a runtime class. */
type Verdict =
  { kind: 'requeue' } | { kind: 'fail'; failureClass: ReaperFailureClass };

const FAILURES: Record<ReaperFailureClass, { code: string; message: string }> =
  {
    cancelled: CANCEL_REQUESTED_FAILURE,
    deadline: {
      code: 'deadline_exceeded',
      message: 'The task ran past its deadline',
    },
    recovery_exhausted: {
      code: 'recovery_exhausted',
      message: 'Every attempt of the task lost its lease',
    },
  };

/**
 * Recovery of tasks left behind (Flow 3), every `RUNTIME_REAPER_MS`. A `running` task whose lease
 * has expired — its worker is gone — returns to `queued` with `recovery_count + 1`
 * (`TaskQueued (recovered)`), so that a new attempt runs it (ADR-0001: a retry is only a runtime
 * attempt after recovery); past its deadline it is `failed` with class `deadline`, and once
 * `RUNTIME_MAX_RECOVERIES` are spent with `recovery_exhausted` (AC-RT-2); with `cancel_requested_at`
 * set — its investigation was cancelled while it ran — it is `cancelled` (Flow 4). A `queued` or `waiting`
 * task past its deadline is `failed` with class `deadline` (AC-19.2). No handler is called; each
 * task is one transaction that writes its guarded row first, then its event.
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

  /** One pass; `true` when a batch was full and more may be left. */
  private async sweep(): Promise<boolean> {
    const now = this.clock.now();
    const expired = await this.db
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
    for (const task of expired) await this.recover(task, now);

    const overdue = await this.db
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
    for (const task of overdue) await this.expire(task, now);

    return expired.length === SWEEP_BATCH || overdue.length === SWEEP_BATCH;
  }

  /** `cancel_requested_at` turns any end into `cancelled` (Data Contract, итог попытки). */
  private verdictOf(task: TaskRow, now: Date): Verdict {
    if (task.cancelRequestedAt !== null) {
      return { kind: 'fail', failureClass: 'cancelled' };
    }
    if (task.deadlineAt !== null && task.deadlineAt <= now) {
      return { kind: 'fail', failureClass: 'deadline' };
    }
    if (task.recoveryCount >= this.config.maxRecoveries) {
      return { kind: 'fail', failureClass: 'recovery_exhausted' };
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
        verdict.failureClass,
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
      `lease expired, failed ${context} failureClass=${verdict.failureClass}`,
    );
  }

  /** A `queued` or `waiting` task past its deadline. */
  private async expire(task: TaskRow, now: Date): Promise<void> {
    const written = await this.db.transaction((tx) =>
      this.writeFailure(
        tx,
        {
          taskId: task.taskId,
          from: [queued, waiting],
          where: lte(researchTasks.deadlineAt, now),
        },
        task,
        'deadline',
        {},
      ),
    );
    if (written) {
      this.logger.warn(
        `deadline passed, failed investigationId=${task.investigationId} taskId=${task.taskId} attempt=${task.attempt}`,
      );
    }
  }

  private async writeFailure(
    tx: RuntimeTx,
    guard: TaskGuard,
    task: TaskRow,
    failureClass: ReaperFailureClass,
    fields: TaskFields,
  ): Promise<TaskRow | undefined> {
    const failure: FailureReason = {
      class: failureClass,
      ...FAILURES[failureClass],
      cause: null,
      attempt: task.attempt,
      toolCalls: task.attemptToolCalls,
      retries: task.attemptRetries,
    };
    const isCancel = failureClass === 'cancelled';
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
