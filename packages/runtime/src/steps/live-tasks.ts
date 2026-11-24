import type { Logger } from '@agent-os/common';
import { RuntimeTasksRepository } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { CancelTimer, Clock } from '../clock';
import type { RuntimeConfig } from '../runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import type { RunningStepHandle } from '../tasks/running-task.registry';
import { HandlerRegistry } from './handler.registry';
import type { StepCommit } from './step-commit';
import type {
  LiveTask,
  LiveTaskIdentity,
  LiveTaskType,
  StepContext,
  TaskHandler,
} from './step-contract';

/** An object no step has used for this long is let go; the task's next step restores it. */
export const LIVE_TASK_IDLE_MS = 15 * 60_000;

/** Most objects kept; over it the ones unused longest and not in a step are let go. */
export const LIVE_TASKS_MAX = 500;

/** Longest an object's `committed` may take; past it the object is let go. */
const COMMITTED_MAX_MS = 30_000;

/** Objects the warm-up restores at once. */
const WARM_CONCURRENCY = 4;

/** The step that runs on an object now. */
interface Holder {
  /** The step's signal: aborted means the step was cut off and may still run on the object. */
  signal: AbortSignal;
  /** Resolves when the step is settled or the object is let go. */
  done: Promise<void>;
  release: () => void;
}

interface Entry {
  object: LiveTask;
  /** Clock time, ms, of the last claim, commit or handover. */
  lastUsedAt: number;
  holder: Holder | undefined;
}

const identityOf = (task: LiveTaskIdentity): LiveTaskIdentity => ({
  taskId: task.taskId,
  rootId: task.rootId,
  parentId: task.parentId,
  ownerId: task.ownerId,
  depth: task.depth,
  type: task.type,
  input: task.input,
});

/**
 * Objects of the tasks of live types (`HandlerRegistry.registerLive`), kept in this process between
 * steps. Only a cache over the database: an object is kept after a committed step and let go on
 * every other end, on a cut-off, when idle or over the cap; a task without an object gets one from
 * its type's `restore`. One step runs on an object at a time: a claim while the previous step is
 * still settling waits for it, and a claim after a cut-off (the previous step's signal is aborted,
 * Invariant 1) lets the object go and restores a new one. A stateless handler is never kept.
 */
@Injectable()
export class LiveTasks {
  private readonly entries = new Map<string, Entry>();
  /** Restores in flight: one per task. */
  private readonly restoring = new Map<string, Promise<void>>();
  /** Raised by {@link clear}: a restore begun before it is not kept. */
  private epoch = 0;
  private readonly logger: Logger;

  constructor(
    @Inject(HandlerRegistry) private readonly handlers: HandlerRegistry,
    @Inject(RuntimeTasksRepository)
    private readonly taskRows: RuntimeTasksRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(RUNTIME_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ worker: 'live-tasks' });
  }

  /**
   * What runs the claimed step: the stateless handler of the task's type, or the task's object —
   * kept, or restored now. Rejects for an unregistered type, a failed `restore` and a step cut off
   * meanwhile.
   */
  async obtain(
    task: LiveTaskIdentity,
    handle: RunningStepHandle,
  ): Promise<Pick<TaskHandler, 'step'>> {
    const handler = this.handlers.handler(task.type);
    if (handler) return handler;
    const type = this.handlers.live(task.type);
    if (!type)
      throw new Error(`No handler is registered for task type "${task.type}"`);
    for (;;) {
      if (handle.signal.aborted) {
        throw new Error(
          `The step of task ${task.taskId} was cut off before it got its object`,
        );
      }
      const entry = this.entries.get(task.taskId);
      if (!entry) {
        await this.restore(type, task);
      } else if (!entry.holder) {
        let release: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
          release = resolve;
        });
        entry.holder = { signal: handle.signal, done, release };
        entry.lastUsedAt = this.now();
        return entry.object;
      } else if (entry.holder.signal.aborted) {
        // Invariant 1: the cut-off step may still run on the object.
        this.drop(task.taskId, entry, 'previous_step_cut_off');
      } else {
        await entry.holder.done;
      }
    }
  }

  /**
   * The step is written, or left unwritten: `commit` is what `StepCommitter.commit` answered,
   * `undefined` for any end without it (exception, step limit, shutdown, a failed write). After a
   * commit the objects it adopted are kept and the step's own object takes the committed state in
   * (`committed`), unless the step finished the task; any other end lets the object go. Never
   * rejects.
   */
  async settled(
    step: StepContext,
    commit: StepCommit | undefined,
  ): Promise<void> {
    try {
      const committed = commit?.outcome === 'committed';
      if (committed) {
        for (const { taskId, object } of commit.adopted)
          this.adopt(taskId, object);
      }
      const entry = this.entries.get(step.taskId);
      const holder = entry?.holder;
      // A stateless type, or the object was let go meanwhile.
      if (!entry || holder?.signal !== step.signal) return;
      try {
        const absorbed = committed && (await this.absorbed(entry.object, step));
        if (this.entries.get(step.taskId) !== entry) {
          // Let go while it took the commit in: a cut-off, or a claim after one.
        } else if (!committed) {
          this.drop(step.taskId, entry, 'step_not_committed');
        } else if (!absorbed) {
          this.drop(step.taskId, entry, 'committed_failed');
        } else if (commit.ended) {
          this.drop(step.taskId, entry, 'task_ended');
        } else {
          entry.lastUsedAt = this.now();
        }
      } finally {
        holder.release();
        if (entry.holder === holder) entry.holder = undefined;
      }
    } catch (error) {
      step.logger.error('live task settle failed', { error });
    }
  }

  /**
   * Keeps the ready object of a task just created outside a step, once its transaction has
   * committed. Does nothing when this instance runs no workers; an object the task already has
   * wins over the given one.
   */
  adopt(taskId: string, object: LiveTask): void {
    if (!this.config.workers) return;
    if (this.entries.has(taskId) || this.restoring.has(taskId)) {
      this.logger.info(
        'live task not adopted: the task has an object already',
        { taskId },
      );
      this.dispose(taskId, object);
      return;
    }
    this.entries.set(taskId, {
      object,
      lastUsedAt: this.now(),
      holder: undefined,
    });
    this.logger.info('live task adopted', { taskId, kept: this.entries.size });
  }

  /** Lets the objects of the tasks go: a command (stop, interrupt, deletion) cut the tasks off. */
  evict(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      const entry = this.entries.get(taskId);
      if (entry) this.drop(taskId, entry, 'cut_off');
    }
  }

  /** Lets go the objects idle for {@link LIVE_TASK_IDLE_MS} and, over the cap, the ones unused longest. */
  sweep(now: Date): void {
    const time = now.getTime();
    const idle: [string, Entry][] = [];
    for (const [taskId, entry] of this.entries) {
      if (entry.holder) continue;
      if (time - entry.lastUsedAt >= LIVE_TASK_IDLE_MS)
        this.drop(taskId, entry, 'idle');
      else idle.push([taskId, entry]);
    }
    const over = this.entries.size - LIVE_TASKS_MAX;
    if (over <= 0) return;
    idle.sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
    for (const [taskId, entry] of idle.slice(0, over))
      this.drop(taskId, entry, 'cap');
  }

  /**
   * After a start: restores the objects of the `queued` and `running` tasks of live types, at most
   * {@link LIVE_TASKS_MAX}, a few at a time. A `waiting` task gets its object at its next step.
   * Never rejects: a failure only logs, and the task's step restores again.
   */
  async warm(): Promise<void> {
    const types = this.handlers.liveTypeNames();
    if (types.length === 0) return;
    const startedAt = Date.now();
    const epoch = this.epoch;
    try {
      const rows = await this.taskRows.listActive(types, LIVE_TASKS_MAX);
      let restored = 0;
      let failed = 0;
      const next = async (): Promise<void> => {
        for (
          let row = rows.shift();
          row && this.epoch === epoch;
          row = rows.shift()
        ) {
          const type = this.handlers.live(row.type);
          if (!type || this.entries.has(row.taskId)) continue;
          try {
            await this.restore(type, row);
            restored += 1;
          } catch {
            // Logged by `restore`.
            failed += 1;
          }
        }
      };
      const found = rows.length;
      await Promise.all(Array.from({ length: WARM_CONCURRENCY }, next));
      this.logger.info('live tasks warmed', {
        types,
        found,
        restored,
        failed,
        kept: this.entries.size,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.logger.warn('live task warm-up failed', {
        types,
        durationMs: Date.now() - startedAt,
        error,
      });
    }
  }

  /** Lets every object go: the workers have stopped. */
  clear(): void {
    this.epoch += 1;
    this.restoring.clear();
    for (const [taskId, entry] of this.entries)
      this.drop(taskId, entry, 'workers_stopped');
  }

  /** Restores the task's object and keeps it; the task's callers share one restore in flight. */
  private restore(type: LiveTaskType, task: LiveTaskIdentity): Promise<void> {
    const inFlight = this.restoring.get(task.taskId);
    if (inFlight) return inFlight;
    const startedAt = Date.now();
    const epoch = this.epoch;
    const fields = {
      taskId: task.taskId,
      rootId: task.rootId,
      ownerId: task.ownerId,
      type: task.type,
    };
    const pending: Promise<void> = Promise.resolve()
      .then(() => type.restore(identityOf(task)))
      .then(
        (object) => {
          if (this.epoch !== epoch || this.entries.has(task.taskId)) {
            this.dispose(task.taskId, object);
            return;
          }
          this.entries.set(task.taskId, {
            object,
            lastUsedAt: this.now(),
            holder: undefined,
          });
          this.logger.info('live task restored', {
            ...fields,
            kept: this.entries.size,
            durationMs: Date.now() - startedAt,
          });
        },
        (error: unknown) => {
          this.logger.warn('live task restore failed', {
            ...fields,
            durationMs: Date.now() - startedAt,
            error,
          });
          throw error;
        },
      )
      .finally(() => {
        if (this.restoring.get(task.taskId) === pending)
          this.restoring.delete(task.taskId);
      });
    this.restoring.set(task.taskId, pending);
    return pending;
  }

  /**
   * The object's `committed`, bounded by {@link COMMITTED_MAX_MS} so that a stuck one does not
   * hold the step's slot and the shutdown. `false` when it threw or ran out of time.
   */
  private async absorbed(
    object: LiveTask,
    step: StepContext,
  ): Promise<boolean> {
    if (!object.committed) return true;
    const startedAt = Date.now();
    let cancel: CancelTimer | undefined;
    const late = new Promise<'late'>((resolve) => {
      cancel = this.clock.setTimer(COMMITTED_MAX_MS, () => resolve('late'));
    });
    try {
      const first = await Promise.race([object.committed(step), late]);
      if (first !== 'late') return true;
      step.logger.error('live task committed() ran too long; object let go', {
        durationMs: Date.now() - startedAt,
      });
      return false;
    } catch (error) {
      step.logger.error('live task committed() failed; object let go', {
        durationMs: Date.now() - startedAt,
        error,
      });
      return false;
    } finally {
      cancel?.();
    }
  }

  private drop(taskId: string, entry: Entry, reason: string): void {
    if (this.entries.get(taskId) === entry) this.entries.delete(taskId);
    entry.holder?.release();
    this.logger.info('live task let go', {
      taskId,
      reason,
      inStep: entry.holder !== undefined,
      kept: this.entries.size,
    });
    this.dispose(taskId, entry.object);
  }

  private dispose(taskId: string, object: LiveTask): void {
    try {
      object.dispose?.();
    } catch (error) {
      this.logger.warn('live task dispose failed', { taskId, error });
    }
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}
