import type { Logger } from '@agent-os/common';
import { TaskStatusSchema, WaitReasonSchema } from '@agent-os/contracts';
import type { Db, RuntimeTasksRepository } from '@agent-os/db';
import type { CancelTimer, Clock } from '../clock';
import type { RuntimeConfig } from '../runtime-config';
import type { TaskRow } from '../tasks/guarded-transition';
import type { RunningStepHandle } from '../tasks/running-task.registry';
import type { Tasks } from '../tasks/tasks';
import { backoffDelay } from '../workers/worker-loop';
import type { StepSignalReason } from './step-contract';

const { queued, running, waiting, stopped } = TaskStatusSchema.enum;

/** Services of a step heartbeat. */
export interface HeartbeatDeps {
  db: Db;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  clock: Clock;
  config: RuntimeConfig;
  logger: Logger;
}

/**
 * The signal of a step whose heartbeat found its attempt no longer current, by the task's status
 * now: a stop (or the deletion of the tree, which stops it first) → `stopped`; an interrupt, which
 * leaves the task `waiting` (`interrupted`) or `queued` → `interrupted`; else the lease was lost.
 */
function fencedSignal(
  current: { status: string; waitReason: string | null } | undefined,
): StepSignalReason {
  if (!current || current.status === stopped) return 'stopped';
  if (current.status === queued) return 'interrupted';
  if (current.status === waiting && current.waitReason === WaitReasonSchema.enum.interrupted) {
    return 'interrupted';
  }
  return 'lease_lost';
}

/**
 * Extends the step's lease every `RUNTIME_HEARTBEAT_MS`, guarded by `running` and the attempt.
 * 0 rows — the attempt is no longer current — aborts with the signal the task's status gives
 * (`stopped`, `interrupted` or `lease_lost`): the cut-off when a NOTIFY was missed. A database
 * failure retries with backoff and aborts with `lease_lost` once the lease has run out.
 */
export class Heartbeat {
  private cancel: CancelTimer | undefined;
  /** The beat being written, if any. */
  private beating: Promise<void> | undefined;
  private stopped = false;
  private failures = 0;
  private leaseExpiresAt: Date;

  constructor(
    private readonly deps: HeartbeatDeps,
    private readonly task: TaskRow,
    private readonly handle: RunningStepHandle,
  ) {
    this.leaseExpiresAt = task.leaseExpiresAt ?? deps.clock.now();
  }

  start(): void {
    this.next(this.deps.config.heartbeatMs);
  }

  /** Stops beating; resolves once a beat in flight has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    await this.beating;
  }

  private next(delayMs: number): void {
    if (this.stopped || this.handle.signal.aborted) return;
    this.cancel = this.deps.clock.setTimer(delayMs, () => {
      this.beating = this.beat().finally(() => {
        this.beating = undefined;
      });
    });
  }

  private async beat(): Promise<void> {
    const { db, tasks, taskRows, clock, config, logger } = this.deps;
    const { taskId, attempt } = this.task;
    const expiresAt = new Date(clock.now().getTime() + config.leaseMs);
    const startedAt = Date.now();
    try {
      const fenced = await db.transaction(async () => {
        const row = await tasks.transition(
          { taskId, from: [running], attempt },
          { kind: 'set', fields: { leaseExpiresAt: expiresAt } },
        );
        if (row) return undefined;
        return fencedSignal(await taskRows.find(taskId));
      });
      this.failures = 0;
      if (fenced) {
        logger.warn('heartbeat found the attempt no longer current', {
          taskId,
          attempt,
          durationMs: Date.now() - startedAt,
          outcome: fenced,
        });
        this.handle.abort(fenced);
        return;
      }
      this.leaseExpiresAt = expiresAt;
      this.next(config.heartbeatMs);
    } catch (error) {
      this.failures += 1;
      logger.error('heartbeat failed', {
        taskId,
        attempt,
        durationMs: Date.now() - startedAt,
        error,
      });
      if (clock.now() >= this.leaseExpiresAt) {
        this.handle.abort('lease_lost');
        return;
      }
      this.next(backoffDelay(config.pollMs, this.failures));
    }
  }
}
