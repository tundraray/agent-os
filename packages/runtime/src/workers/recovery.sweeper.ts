import type { Logger } from '@agent-os/common';
import {
  RuntimeEventTypeSchema,
  RuntimeFailureReasonSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import {
  Db,
  RuntimeTrackersRepository,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../clock';
import { CrashPoints } from '../crash-points';
import { EventLog } from '../events/event-log';
import type { TaskRow } from '../tasks/guarded-transition';
import { Inbox } from '../messaging/inbox';
import { WorkerLoop } from './worker-loop';
import type { RuntimeConfig } from '../runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { endTask } from '../tasks/task-end';
import { Tasks } from '../tasks/tasks';

const { queued, running, failed } = TaskStatusSchema.enum;

/** Tasks taken by one pass. */
const SWEEP_BATCH = 50;

interface RecoverySweeperDeps {
  db: Db;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  trackers: RuntimeTrackersRepository;
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
 * is one transaction.
 */
@Injectable()
export class RecoverySweeper {
  private readonly loop: WorkerLoop;
  private readonly deps: RecoverySweeperDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
    @Inject(CLOCK) clock: Clock,
    @Inject(RUNTIME_LOGGER) runtimeLogger: Logger,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(RuntimeTrackersRepository) trackers: RuntimeTrackersRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(Inbox) inbox: Inbox,
    @Inject(CrashPoints) crashPoints: CrashPoints,
  ) {
    const logger = runtimeLogger.child({ worker: 'sweeper' });
    this.deps = { db, config, clock, logger, tasks, taskRows, trackers, events, inbox, crashPoints };
    this.loop = new WorkerLoop({
      name: 'sweeper',
      periodMs: config.reaperMs,
      pollMs: config.pollMs,
      clock,
      logger,
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
    const expired = await this.deps.taskRows.listExpired(now, SWEEP_BATCH);
    for (const task of expired) await this.recover(task, now);
    return expired.length === SWEEP_BATCH;
  }

  private async recover(
    expired: { taskId: string; attempt: number },
    now: Date,
  ): Promise<void> {
    const { db, logger, crashPoints, config } = this.deps;
    const startedAt = Date.now();
    const recovery = await db.transaction(() => this.recoverIn(expired, now));
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
    expired: { taskId: string; attempt: number },
    now: Date,
  ): Promise<Recovery> {
    const { tasks, taskRows, events, config } = this.deps;
    const task = await taskRows.find(expired.taskId);
    const stillLost =
      task?.status === running &&
      task.attempt === expired.attempt &&
      task.leaseExpiresAt !== null &&
      task.leaseExpiresAt < now;
    if (!task || !stillLost) return { kind: 'skipped' };

    if (task.recoveries >= config.maxRecoveries) {
      const row = await endTask(this.deps, task, {
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
      { taskId: task.taskId, from: [running], attempt: task.attempt },
      {
        kind: 'set',
        status: queued,
        fields: { recoveries: task.recoveries + 1 },
        fence: true,
      },
    );
    if (!row) throw new Error(`Guarded write of task ${task.taskId} matched no row`);
    await events.append({
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
