import type { Logger } from '@agent-os/common';
import {
  RuntimeEventTypeSchema,
  RuntimeFailureReasonSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { type Database, runtimeTasks } from '@agent-os/db';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import type { CrashPoints } from './crash-points.js';
import type { EventLog } from './event-log.js';
import type { TaskRow } from './guarded-transition.js';
import type { Inbox } from './inbox.js';
import { WorkerLoop } from './outbox.relay.js';
import type { RuntimeConfig } from './runtime-config.js';
import { retryingTransaction, type RuntimeTx } from './runtime-tx.js';
import { endTask } from './step-commit.js';
import type { TaskRepository } from './task.repository.js';

const { queued, running, failed } = TaskStatusSchema.enum;

/** Tasks taken by one pass. */
const SWEEP_BATCH = 50;

export interface RecoverySweeperDeps {
  db: Database;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  tasks: TaskRepository;
  events: EventLog;
  inbox: Inbox;
  crashPoints: CrashPoints;
}

/** What the sweeper did with one task whose lease expired. */
type Recovery =
  | { kind: 'requeued'; row: TaskRow }
  | { kind: 'exhausted'; row: TaskRow }
  /** A heartbeat extended the lease, the step committed, or another sweeper took it. */
  | { kind: 'skipped' };

/**
 * Recovery of lost steps (Flow 2), every `RUNTIME_REAPER_MS`. A `running` task whose lease has
 * expired — its process is gone or lost the database — returns to `queued` with `recoveries + 1`,
 * `attempt + 1` (a late outcome of the lost attempt is fenced) and `task.recovered`, so that a new
 * claim runs the step again. Once the step was lost `RUNTIME_MAX_RECOVERIES` times in a row, the
 * task is `failed` with `recovery_exhausted` and its parent is told. No handler is called; each task
 * is one transaction under its row lock.
 */
export class RecoverySweeper {
  private readonly loop: WorkerLoop;

  constructor(private readonly deps: RecoverySweeperDeps) {
    this.loop = new WorkerLoop({
      name: 'sweeper',
      periodMs: deps.config.reaperMs,
      pollMs: deps.config.pollMs,
      clock: deps.clock,
      logger: deps.logger,
      pass: () => this.sweep(),
    });
  }

  start(): void {
    this.loop.start();
  }

  shutdown(): Promise<void> {
    return this.loop.stop();
  }

  /** One pass; `true` when the batch was full and more may be left. */
  private async sweep(): Promise<boolean> {
    const now = this.deps.clock.now();
    const expired = await this.deps.db
      .select({ taskId: runtimeTasks.taskId, attempt: runtimeTasks.attempt })
      .from(runtimeTasks)
      .where(
        and(eq(runtimeTasks.status, running), lt(runtimeTasks.leaseExpiresAt, now)),
      )
      .orderBy(asc(runtimeTasks.leaseExpiresAt))
      .limit(SWEEP_BATCH);
    for (const task of expired) await this.recover(task, now);
    return expired.length === SWEEP_BATCH;
  }

  private async recover(
    expired: { taskId: string; attempt: number },
    now: Date,
  ): Promise<void> {
    const { db, logger, crashPoints, config } = this.deps;
    const startedAt = Date.now();
    const recovery = await retryingTransaction(db, logger, 'sweeper.recover', (tx) =>
      this.recoverIn(tx, expired, now),
    );
    const fields = {
      taskId: expired.taskId,
      attempt: expired.attempt,
      durationMs: Date.now() - startedAt,
    };
    switch (recovery.kind) {
      case 'skipped':
        logger.debug('lost step not recovered: the lease is no longer expired', {
          ...fields,
          outcome: 'skipped',
        });
        return;
      case 'requeued':
        logger.warn('lost step requeued: the lease expired', {
          ...fields,
          rootId: recovery.row.rootId,
          ownerId: recovery.row.ownerId,
          type: recovery.row.type,
          stepNo: recovery.row.stepNo,
          recoveries: recovery.row.recoveries,
          outcome: 'requeued',
        });
        crashPoints.hit('sweeper.after-requeue');
        return;
      case 'exhausted':
        logger.error('task failed: its step was lost too many times', {
          ...fields,
          rootId: recovery.row.rootId,
          ownerId: recovery.row.ownerId,
          type: recovery.row.type,
          stepNo: recovery.row.stepNo,
          maxRecoveries: config.maxRecoveries,
          reason: RuntimeFailureReasonSchema.enum.recovery_exhausted,
          outcome: 'failed',
        });
        return;
    }
  }

  private async recoverIn(
    tx: RuntimeTx,
    expired: { taskId: string; attempt: number },
    now: Date,
  ): Promise<Recovery> {
    const { tasks, events, inbox, config } = this.deps;
    // An exhausted task ends and notifies its parent: the parent is locked first (Invariant 6).
    const task = await tasks.lockWithParent(tx, expired.taskId);
    const stillLost =
      task?.status === running &&
      task.attempt === expired.attempt &&
      task.leaseExpiresAt !== null &&
      task.leaseExpiresAt < now;
    if (!task || !stillLost) return { kind: 'skipped' };

    if (task.recoveries >= config.maxRecoveries) {
      const row = await endTask(tx, { tasks, events, inbox }, task, {
        status: failed,
        failure: {
          reason: RuntimeFailureReasonSchema.enum.recovery_exhausted,
          message: `The step was lost ${task.recoveries + 1} times in a row`,
        },
        fields: { stepClaims: 0, recoveries: 0 },
        fence: true,
      });
      return { kind: 'exhausted', row };
    }

    const row = await tasks.transition(
      tx,
      { taskId: task.taskId, from: [running], attempt: task.attempt },
      {
        kind: 'set',
        status: queued,
        fields: { recoveries: sql`${runtimeTasks.recoveries} + 1` },
        fence: true,
      },
    );
    if (!row) throw new Error(`Write of locked task ${task.taskId} matched no row`);
    await events.append(tx, {
      type: RuntimeEventTypeSchema.enum['task.recovered'],
      task: row,
      payload: {
        stepNo: row.stepNo,
        lostAttempt: task.attempt,
        recoveries: row.recoveries,
      },
    });
    return { kind: 'requeued', row };
  }
}
