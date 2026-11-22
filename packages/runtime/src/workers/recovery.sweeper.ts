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
import { HandlerRegistry } from '../steps/handler.registry';
import { RunningTaskRegistry } from '../tasks/running-task.registry';
import { endTask } from '../tasks/task-end';
import { Tasks } from '../tasks/tasks';

const { queued, running, failed } = TaskStatusSchema.enum;

interface RecoverySweeperDeps {
  db: Db;
  config: RuntimeConfig;
  logger: Logger;
  handlers: HandlerRegistry;
  running: RunningTaskRegistry;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  trackers: RuntimeTrackersRepository;
  events: EventLog;
  inbox: Inbox;
  crashPoints: CrashPoints;
}

/** What the sweeper did with one lost task. */
type Recovery =
  | { kind: 'requeued'; row: TaskRow }
  | { kind: 'exhausted'; row: TaskRow }
  /** The step was written meanwhile. */
  | { kind: 'skipped' };

/**
 * Recovery of lost steps (Flow 2): at the start and then every `RUNTIME_REAPER_MS`. One process
 * executes steps, so a `running` task of a type registered here whose step this process does not
 * execute (`RunningTaskRegistry`) is lost: the process that claimed it crashed, or its step ended
 * without its write (the database was unreachable). The task returns to `queued` with
 * `recoveries + 1`, `attempt + 1` and `task.recovered`, so that a new claim runs the step again.
 * Once the step was lost `RUNTIME_MAX_RECOVERIES` times in a row, the task is `failed` with
 * `recovery_exhausted` and its parent is told. No handler is called; each task is one transaction.
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
    @Inject(HandlerRegistry) handlers: HandlerRegistry,
    @Inject(RunningTaskRegistry) running: RunningTaskRegistry,
  ) {
    const logger = runtimeLogger.child({ worker: 'sweeper' });
    this.deps = {
      db,
      config,
      logger,
      handlers,
      running,
      tasks,
      taskRows,
      trackers,
      events,
      inbox,
      crashPoints,
    };
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

  /** One pass over the `running` tasks; never leaves work for an immediate next pass. */
  private async sweep(): Promise<boolean> {
    const { taskRows, handlers, running } = this.deps;
    const types = handlers.types();
    if (types.length === 0) return false;
    const claimed = await taskRows.listRunning(types);
    for (const task of claimed) {
      if (!running.isRunning(task.taskId, task.attempt)) await this.recover(task);
    }
    return false;
  }

  private async recover(lost: { taskId: string; attempt: number }): Promise<void> {
    const { db, logger, crashPoints, config } = this.deps;
    const startedAt = Date.now();
    const recovery = await db.transaction(() => this.recoverIn(lost));
    const fields = {
      taskId: lost.taskId,
      attempt: lost.attempt,
      durationMs: Date.now() - startedAt,
    };
    switch (recovery.kind) {
      case 'skipped':
        logger.debug('lost step not recovered: it was written meanwhile', {
          ...fields,
          outcome: 'skipped',
        });
        return;
      case 'requeued':
        logger.warn('lost step requeued: no step of this process runs the task', {
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

  private async recoverIn(lost: { taskId: string; attempt: number }): Promise<Recovery> {
    const { tasks, taskRows, events, config } = this.deps;
    const task = await taskRows.find(lost.taskId);
    if (task?.status !== running || task.attempt !== lost.attempt) return { kind: 'skipped' };

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
