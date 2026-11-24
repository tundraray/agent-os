import type { Logger } from '@agent-os/common';
import {
  RuntimeFailureReasonSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { Db, RuntimeTasksRepository, type RuntimeTaskRow } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../clock';
import { CrashPoints } from '../crash-points';
import { Inbox } from '../messaging/inbox';
import { WorkerLoop } from './worker-loop';
import type { RuntimeConfig } from '../runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { HandlerRegistry } from '../steps/handler.registry';
import { LiveTasks } from '../steps/live-tasks';
import { RunningTaskRegistry } from '../tasks/running-task.registry';
import {
  cutOff,
  type EndedTask,
  endTask,
  logTaskEnds,
  type TaskEndDeps,
  taskLogFields,
  writeHeld,
} from '../tasks/task-end';
import { TaskEndHooks } from '../tasks/task-end-hooks';
import { Tasks } from '../tasks/tasks';
import { withTxRetry } from '../tasks/transaction-retry';

const { queued, running, failed } = TaskStatusSchema.enum;

interface RecoverySweeperDeps extends TaskEndDeps {
  config: RuntimeConfig;
  handlers: HandlerRegistry;
  running: RunningTaskRegistry;
  live: LiveTasks;
  crashPoints: CrashPoints;
}

/** What the sweeper did with one lost task. */
type Recovery =
  | { kind: 'requeued'; row: RuntimeTaskRow }
  | { kind: 'exhausted'; ended: EndedTask }
  /** The step was written meanwhile. */
  | { kind: 'skipped' };

/**
 * Recovery of lost steps (Flow 2): at the start and then every `RUNTIME_REAPER_MS`. One process
 * executes steps, so a `running` task of a type registered here whose step this process does not
 * execute (`RunningTaskRegistry`) is lost: the process that claimed it crashed, or its step ended
 * without its write (the database was unreachable). The task returns to `queued` with
 * `recoveries + 1` and `attempt + 1`, so that a new claim runs the step again.
 * Once the step was lost `RUNTIME_MAX_RECOVERIES` times in a row, the task is `failed` with
 * `recovery_exhausted` and its parent is told; its pending messages go with the failure, so only a
 * new message revives it. No handler is called; each task is one transaction.
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
    @Inject(Inbox) inbox: Inbox,
    @Inject(TaskEndHooks) endHooks: TaskEndHooks,
    @Inject(CrashPoints) crashPoints: CrashPoints,
    @Inject(HandlerRegistry) handlers: HandlerRegistry,
    @Inject(RunningTaskRegistry) running: RunningTaskRegistry,
    @Inject(LiveTasks) live: LiveTasks,
  ) {
    const logger = runtimeLogger.child({ worker: 'sweeper' });
    this.deps = {
      db,
      config,
      logger,
      handlers,
      running,
      live,
      tasks,
      taskRows,
      inbox,
      endHooks,
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
      if (!running.isRunning(task.taskId, task.attempt))
        await this.recover(task);
    }
    return false;
  }

  private async recover(lost: {
    taskId: string;
    attempt: number;
  }): Promise<void> {
    const { db, logger, crashPoints, config } = this.deps;
    const startedAt = Date.now();
    const recovery = await withTxRetry(
      { db, logger, operation: 'sweeper.recover', taskId: lost.taskId },
      () => this.recoverIn(lost),
    );
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
        logger.warn(
          'lost step requeued: no step of this process runs the task',
          {
            ...fields,
            ...taskLogFields(recovery.row),
            lostAttempt: lost.attempt,
            from: running,
            to: recovery.row.status,
            cause: 'recovery',
            recoveries: recovery.row.recoveries,
            outcome: 'requeued',
          },
        );
        crashPoints.hit('sweeper.after-requeue');
        return;
      case 'exhausted':
        cutOff(this.deps, recovery.ended.stopped, 'stopped');
        logTaskEnds(logger, recovery.ended.ends);
        logger.error('task failed: its step was lost too many times', {
          ...fields,
          ...taskLogFields(recovery.ended.row),
          lostAttempt: lost.attempt,
          maxRecoveries: config.maxRecoveries,
          reason: RuntimeFailureReasonSchema.enum.recovery_exhausted,
          outcome: 'failed',
          stoppedIds: recovery.ended.stopped.map((task) => task.taskId),
        });
        return;
    }
  }

  private async recoverIn(lost: {
    taskId: string;
    attempt: number;
  }): Promise<Recovery> {
    const { tasks, inbox, config } = this.deps;
    const task = await tasks.hold({
      taskId: lost.taskId,
      from: [running],
      attempt: lost.attempt,
    });
    if (!task) return { kind: 'skipped' };

    if (task.recoveries >= config.maxRecoveries) {
      // The lost steps' messages go with the failure, so a `revive` among them does not requeue the
      // task into the same losses again. Which of them the last lost step was handed is not known
      // here: every pending one goes, and only a message written after this end revives the task.
      const pending = await inbox.loadPending(task.taskId);
      await inbox.markDelivered(
        task,
        pending.map((message) => message.messageId),
      );
      const ended = await endTask(this.deps, task, {
        status: failed,
        failure: {
          reason: RuntimeFailureReasonSchema.enum.recovery_exhausted,
          message: `The step was lost ${task.recoveries + 1} times in a row`,
        },
        fields: { recoveries: 0 },
        fence: true,
        cause: 'recovery',
      });
      return { kind: 'exhausted', ended };
    }

    const row = await writeHeld(tasks, task, {
      kind: 'set',
      status: queued,
      fields: { recoveries: task.recoveries + 1 },
      fence: true,
    });
    return { kind: 'requeued', row };
  }
}
