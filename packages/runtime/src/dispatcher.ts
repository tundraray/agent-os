import type { Logger } from '@agent-os/common';
import {
  RuntimeEventTypeSchema,
  RuntimeFailureReasonSchema,
  type RuntimeFailureReason,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type Database, runtimeTasks } from '@agent-os/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type pg from 'pg';
import type { CancelTimer, Clock } from './clock.js';
import type { CrashPoints } from './crash-points.js';
import { type EventLog, RUNTIME_EVENTS_CHANNEL } from './event-log.js';
import type { TaskRow } from './guarded-transition.js';
import type {
  HandlerRegistry,
  StepResult,
  StepSignalReason,
  TaskHandler,
} from './handler.registry.js';
import type { DecisionRow, Decisions } from './decisions.js';
import type { Inbox, MessageRow } from './inbox.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { RuntimeTx } from './runtime-tx.js';
import type {
  RunningStepHandle,
  RunningTaskRegistry,
} from './running-task.registry.js';
import { endTask, type StepCommitter } from './step-commit.js';
import { boundTransaction, TaskStepContext } from './step-context.js';
import type { TaskRepository } from './task.repository.js';

const { queued, running, waiting, failed, stopped } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;
const FAILURE = RuntimeFailureReasonSchema.enum;

/** Backoff of the dispatch loop doubles from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`. */
const MAX_BACKOFF_DOUBLINGS = 4;
/** Bound of a failure message the runtime writes; it travels in the parent's notice. */
const FAILURE_MESSAGE_MAX = 2_000;

/** Delay after the `failures`-th consecutive failure of a loop (1-based). */
const backoffDelay = (pollMs: number, failures: number): number =>
  pollMs * 2 ** Math.min(Math.max(failures - 1, 0), MAX_BACKOFF_DOUBLINGS);

/** Commands whose event cuts off the task's step in flight, and the signal reason they give. */
const CUT_OFF_REASONS: ReadonlyMap<string, StepSignalReason> = new Map([
  [EVENT['task.interrupted'], 'interrupted'],
  [EVENT['task.stopped'], 'stopped'],
]);

/** The payload of a `runtime_events` notice (plan Notes 7). */
interface TaskNotice {
  rootId: string;
  taskId: string;
  type: string;
}

/** The notice's payload, or `undefined` when it is not one the runtime wrote. */
function parseNotice(payload: string | undefined): TaskNotice | undefined {
  if (payload === undefined) return undefined;
  try {
    const value = JSON.parse(payload) as Partial<Record<keyof TaskNotice, unknown>> | null;
    if (
      typeof value?.rootId !== 'string' ||
      typeof value.taskId !== 'string' ||
      typeof value.type !== 'string'
    ) {
      return undefined;
    }
    return { rootId: value.rootId, taskId: value.taskId, type: value.type };
  } catch {
    return undefined;
  }
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

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    FAILURE_MESSAGE_MAX,
  );

/** How the handler's step ended, as the dispatcher saw it. */
type Execution =
  | { kind: 'returned'; result: StepResult }
  | { kind: 'threw'; error: unknown }
  /** `RUNTIME_STEP_MS` passed first. */
  | { kind: 'timed_out' }
  /** Shutdown, and the handler did not return a result within `RUNTIME_SHUTDOWN_GRACE_MS`. */
  | { kind: 'shut_down' };

/** The handler's own end, without the dispatcher's limits. */
type HandlerEnd = Extract<Execution, { kind: 'returned' | 'threw' }>;

/**
 * A claimed step: the task row after the claim, the messages pending at its start and the resolved
 * decision no committed step has received yet.
 */
interface ClaimedTask {
  task: TaskRow;
  messages: MessageRow[];
  decision: DecisionRow | undefined;
}

/** A promise with its resolve, to race the shutdown against steps in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export interface DispatcherDeps {
  db: Database;
  /** The pool of `db`: one of its connections LISTENs. */
  pool: pg.Pool;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  handlers: HandlerRegistry;
  tasks: TaskRepository;
  events: EventLog;
  inbox: Inbox;
  decisions: Decisions;
  running: RunningTaskRegistry;
  committer: StepCommitter;
  crashPoints: CrashPoints;
}

/**
 * Execution of steps (Flow 1, Flow 2). A tick — at least every `RUNTIME_POLL_MS`, sooner on any
 * NOTIFY of `runtime_events` or when a slot frees — claims while slots (`RUNTIME_CONCURRENCY`) are
 * free the oldest `queued` task of a type registered here: `FOR UPDATE SKIP LOCKED`, then the
 * guarded claim re-checks `queued` under the lock. Each step runs its handler outside any
 * transaction with a signal (step limit, heartbeat, shutdown) and ends in the commit transaction,
 * or — exception, step limit, shutdown — in a guarded write of the dispatcher that raises the
 * attempt, so that a late result and `guard` of the step are fenced (Invariant 1).
 */
export class Dispatcher {
  private started = false;
  /** Slots taken by claims in flight and running steps. */
  private busySlots = 0;
  private readonly steps = new Set<Promise<void>>();
  private cancelTick: CancelTimer | undefined;
  private tickInFlight: Promise<void> | undefined;
  private tickRequested = false;
  private loopFailures = 0;
  private listener: pg.PoolClient | undefined;
  private shutdownSignal = deferred();

  constructor(private readonly deps: DispatcherDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shutdownSignal = deferred();
    this.schedule(0);
  }

  /**
   * Stops claiming and signals `shutdown` to the steps in flight. A step that returns within
   * `RUNTIME_SHUTDOWN_GRACE_MS` is committed; the others go back to `queued` without counting a
   * loss. Resolves when every step is written, then stops listening; the pool is closed after it.
   */
  async shutdown(): Promise<void> {
    this.started = false;
    this.cancelTick?.();
    this.cancelTick = undefined;
    await this.tickInFlight;
    this.shutdownSignal.resolve();
    await this.deps.running.abortAll('shutdown');
    await Promise.all(this.steps);
    this.dropListener();
  }

  /** Runs a tick soon: a hint (NOTIFY, a freed slot), never the guarantee — that is the poll. */
  private wake(): void {
    if (!this.started) return;
    if (this.tickInFlight) this.tickRequested = true;
    else this.schedule(0);
  }

  private schedule(delayMs: number): void {
    this.cancelTick?.();
    this.cancelTick = this.deps.clock.setTimer(delayMs, () => {
      this.cancelTick = undefined;
      this.tickInFlight = this.tick().finally(() => {
        this.tickInFlight = undefined;
      });
    });
  }

  private async tick(): Promise<void> {
    const { config, logger } = this.deps;
    let delay = config.pollMs;
    try {
      await this.listen();
      await this.claimFreeSlots();
      this.loopFailures = 0;
    } catch (error) {
      this.loopFailures += 1;
      delay = backoffDelay(config.pollMs, this.loopFailures);
      logger.error('dispatcher tick failed', { error, retryInMs: delay });
    }
    if (!this.started) return;
    if (this.tickRequested && this.loopFailures === 0) delay = 0;
    this.tickRequested = false;
    this.schedule(delay);
  }

  private async claimFreeSlots(): Promise<void> {
    while (this.started && this.busySlots < this.deps.config.concurrency) {
      this.busySlots += 1;
      let claimed: ClaimedTask | undefined;
      try {
        claimed = await this.claimNext();
      } finally {
        if (!claimed) this.busySlots -= 1;
      }
      if (!claimed) return;
      this.track(this.runStep(claimed));
    }
  }

  private track(step: Promise<void>): void {
    this.steps.add(step);
    void step.finally(() => {
      this.steps.delete(step);
      this.busySlots -= 1;
      this.wake();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------------------------

  /**
   * Claims the oldest ready task in one transaction: `running`, `attempt + 1`, `step_claims + 1`,
   * the lease, the pending messages and `task.step_started`.
   */
  private async claimNext(): Promise<ClaimedTask | undefined> {
    const { db, handlers, tasks, events, inbox, decisions, clock, config, crashPoints } =
      this.deps;
    const types = handlers.types();
    if (types.length === 0) return undefined;
    const claimed = await db.transaction(async (tx) => {
      const taskId = await this.lockReadyTask(tx, types);
      if (!taskId) return undefined;
      // The guard re-checks `queued` under the lock.
      const task = await tasks.transition(
        tx,
        { taskId, from: [queued] },
        {
          kind: 'claim',
          leaseExpiresAt: new Date(clock.now().getTime() + config.leaseMs),
        },
      );
      if (!task) return undefined;
      const messages = await inbox.loadPending(tx, taskId);
      const decision = await decisions.loadUndelivered(tx, taskId);
      await events.append(tx, {
        type: EVENT['task.step_started'],
        task,
        payload: {
          stepNo: task.stepNo,
          attempt: task.attempt,
          messages: messages.length,
        },
      });
      return { task, messages, decision };
    });
    if (claimed) crashPoints.hit('step.after-claim');
    return claimed;
  }

  /** Locks the oldest `queued` task of a registered type, skipping rows other claims hold. */
  private async lockReadyTask(
    tx: RuntimeTx,
    types: readonly string[],
  ): Promise<string | undefined> {
    const [ready] = await tx
      .select({ taskId: runtimeTasks.taskId })
      .from(runtimeTasks)
      .where(and(eq(runtimeTasks.status, queued), inArray(runtimeTasks.type, [...types])))
      .orderBy(asc(runtimeTasks.createdAt), asc(runtimeTasks.taskId))
      .limit(1)
      .for('update', { skipLocked: true });
    return ready?.taskId;
  }

  // ---------------------------------------------------------------------------------------------
  // Step
  // ---------------------------------------------------------------------------------------------

  /** Runs the claimed step to its write; never rejects. */
  private async runStep(claimed: ClaimedTask): Promise<void> {
    const { task, messages, decision } = claimed;
    const handle = this.deps.running.register(task);
    const step = new TaskStepContext(
      {
        db: this.deps.db,
        tasks: this.deps.tasks,
        crashPoints: this.deps.crashPoints,
        logger: this.deps.logger,
        leaseMs: this.deps.config.leaseMs,
      },
      { task, messages, decision, signal: handle.signal },
    );
    const heartbeat = new Heartbeat(this.deps, task, handle);
    const startedAt = Date.now();
    step.logger.info('step started', {
      messageIds: step.messageIds,
      resumedAfterLoss: step.resumedAfterLoss,
    });
    try {
      heartbeat.start();
      const execution = await this.execute(step, handle);
      await heartbeat.stop();
      await this.settle(step, execution, startedAt);
    } catch (error) {
      step.logger.error('step write failed; left to lease expiry', {
        durationMs: Date.now() - startedAt,
        error,
      });
    } finally {
      await heartbeat.stop();
      handle.release();
    }
  }

  /**
   * The handler's step raced against the step limit and the shutdown. An interrupt or a lost lease
   * only aborts the signal: the handler is expected to end the step, and its result is fenced. On
   * shutdown the handler gets up to `RUNTIME_SHUTDOWN_GRACE_MS` to return.
   */
  private async execute(
    step: TaskStepContext,
    handle: RunningStepHandle,
  ): Promise<Execution> {
    const { handlers, clock, config } = this.deps;
    const handler: TaskHandler | undefined = handlers.get(step.type);
    const run: Promise<HandlerEnd> = Promise.resolve()
      .then(() => {
        if (!handler) throw new Error(`No handler is registered for task type "${step.type}"`);
        return handler.step(step);
      })
      .then(
        (result): HandlerEnd => ({ kind: 'returned', result }),
        (error: unknown): HandlerEnd => ({ kind: 'threw', error }),
      );

    let cancelLimit: CancelTimer | undefined;
    const timedOut = new Promise<Execution>((resolve) => {
      cancelLimit = clock.setTimer(config.stepMs, () => {
        handle.abort('step_timeout');
        resolve({ kind: 'timed_out' });
      });
    });
    const shutdown = this.shutdownSignal.promise.then(() => 'shutdown' as const);
    try {
      const first = await Promise.race([run, timedOut, shutdown]);
      if (first !== 'shutdown') return first;
      handle.abort('shutdown');
      return await this.withinGrace(run);
    } finally {
      cancelLimit?.();
    }
  }

  /** The handler's end within `RUNTIME_SHUTDOWN_GRACE_MS`, else `shut_down`. */
  private async withinGrace(run: Promise<HandlerEnd>): Promise<Execution> {
    let cancel: CancelTimer | undefined;
    const grace = new Promise<Execution>((resolve) => {
      cancel = this.deps.clock.setTimer(this.deps.config.shutdownGraceMs, () =>
        resolve({ kind: 'shut_down' }),
      );
    });
    try {
      const end = await Promise.race([run, grace]);
      // An exception after the shutdown signal is the handler giving up the step, not a failure.
      return end.kind === 'threw' ? { kind: 'shut_down' } : end;
    } finally {
      cancel?.();
    }
  }

  /** Writes how the step ended. */
  private async settle(
    step: TaskStepContext,
    execution: Execution,
    startedAt: number,
  ): Promise<void> {
    switch (execution.kind) {
      case 'returned':
        await this.deps.committer.commit(step, execution.result);
        return;
      case 'threw':
        if (step.signal.aborted) {
          // The step was cut off (interrupt, stop, lost lease): its attempt is no longer current.
          step.logger.warn('step ended by its signal; nothing written', {
            signal: step.signal.reason,
            durationMs: Date.now() - startedAt,
            error: execution.error,
          });
          return;
        }
        await this.failStep(step, FAILURE.handler_error, execution.error, startedAt);
        return;
      case 'timed_out':
        await this.failStep(
          step,
          FAILURE.step_timeout,
          new Error(`The step ran past ${this.deps.config.stepMs} ms`),
          startedAt,
        );
        return;
      case 'shut_down':
        await this.requeue(step, startedAt);
        return;
    }
  }

  /**
   * Fails the task with a runtime reason through the one end-of-task procedure (its parent is
   * told), if the attempt is still current; `attempt + 1` fences a late result of the step.
   */
  private async failStep(
    step: TaskStepContext,
    reason: Extract<RuntimeFailureReason, 'handler_error' | 'step_timeout'>,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const { db, tasks, events, inbox, config } = this.deps;
    const ended = await db.transaction(async (tx) => {
      await boundTransaction(tx, config.leaseMs);
      // The failure notifies the parent: the parent is locked first (Invariant 6).
      const task = await tasks.lockWithParent(tx, step.taskId);
      if (task?.status !== running || task.attempt !== step.attempt) return undefined;
      return endTask(tx, { tasks, events, inbox }, task, {
        status: failed,
        failure: { reason, message: errorMessage(error) },
        fields: { stepClaims: 0, recoveries: 0 },
        fence: true,
      });
    });
    const fields = { reason, durationMs: Date.now() - startedAt, error };
    if (!ended) {
      step.logger.warn('step failure rejected: the attempt is no longer current', {
        ...fields,
        outcome: 'rejected',
      });
      return;
    }
    step.logger.error('step failed: task failed', { ...fields, outcome: ended.status });
  }

  /** Shutdown: the task goes back to `queued` without counting a loss; `attempt + 1`. */
  private async requeue(step: TaskStepContext, startedAt: number): Promise<void> {
    const { db, tasks, events } = this.deps;
    const row = await db.transaction(async (tx) => {
      const requeued = await tasks.transition(
        tx,
        { taskId: step.taskId, from: [running], attempt: step.attempt },
        { kind: 'set', status: queued, fence: true },
      );
      if (!requeued) return undefined;
      await events.append(tx, {
        type: EVENT['task.queued'],
        task: requeued,
        payload: { cause: 'shutdown', from: running },
      });
      return requeued;
    });
    const durationMs = Date.now() - startedAt;
    if (!row) {
      step.logger.warn('shutdown requeue rejected: the attempt is no longer current', {
        durationMs,
        outcome: 'rejected',
      });
      return;
    }
    step.logger.warn('step requeued on shutdown', { durationMs, outcome: 'queued' });
  }

  // ---------------------------------------------------------------------------------------------
  // LISTEN
  // ---------------------------------------------------------------------------------------------

  /**
   * Holds one pooled connection on `LISTEN runtime_events` while `RUNTIME_NOTIFY` is on; any
   * notification ticks. A failure only logs: the poll goes on.
   */
  private async listen(): Promise<void> {
    const { config, pool, logger } = this.deps;
    if (!config.notify || this.listener || !this.started) return;
    let client: pg.PoolClient | undefined;
    try {
      client = await pool.connect();
      client.on('notification', (notice) => {
        this.cutOff(notice.payload);
        this.wake();
      });
      client.on('error', (error) => {
        logger.warn('listen connection lost, polling until it is back', { error });
        this.dropListener(error);
      });
      await client.query(`LISTEN "${RUNTIME_EVENTS_CHANNEL}"`);
      this.listener = client;
    } catch (error) {
      client?.release(error instanceof Error ? error : true);
      logger.warn('listen failed, polling only', { error });
    }
  }

  /**
   * KD-4: a `task.interrupted` or `task.stopped` notice cuts off this process's steps of the task
   * whose attempt is below the task's current one — a step claimed after the command keeps going.
   * A deleted task cuts off all of them. A failure only logs: the heartbeat finds the step anyway.
   */
  private cutOff(payload: string | undefined): void {
    const notice = parseNotice(payload);
    const reason = notice && CUT_OFF_REASONS.get(notice.type);
    if (!notice || !reason) return;
    this.cutOffTask(notice, reason).catch((error: unknown) => {
      this.deps.logger.warn('cut-off on notice failed; left to the heartbeat', {
        taskId: notice.taskId,
        rootId: notice.rootId,
        signal: reason,
        error,
      });
    });
  }

  private async cutOffTask(notice: TaskNotice, reason: StepSignalReason): Promise<void> {
    const [current] = await this.deps.db
      .select({ attempt: runtimeTasks.attempt })
      .from(runtimeTasks)
      .where(eq(runtimeTasks.taskId, notice.taskId));
    // Not awaited: the steps end when their handlers answer the signal.
    void this.deps.running.abortTask(notice.taskId, reason, current?.attempt);
  }

  private dropListener(error?: Error): void {
    const client = this.listener;
    this.listener = undefined;
    // A connection that was listening goes back destroyed: it must not serve queries.
    client?.release(error ?? true);
  }
}

/**
 * Extends the step's lease every `RUNTIME_HEARTBEAT_MS`, guarded by `running` and the attempt.
 * 0 rows — the attempt is no longer current — aborts with the signal the task's status gives
 * (`stopped`, `interrupted` or `lease_lost`): the cut-off when a NOTIFY was missed. A database
 * failure retries with backoff and aborts with `lease_lost` once the lease has run out.
 */
class Heartbeat {
  private cancel: CancelTimer | undefined;
  /** The beat being written, if any. */
  private beating: Promise<void> | undefined;
  private stopped = false;
  private failures = 0;
  private leaseExpiresAt: Date;

  constructor(
    private readonly deps: Pick<
      DispatcherDeps,
      'db' | 'tasks' | 'clock' | 'config' | 'logger'
    >,
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
    const { db, tasks, clock, config, logger } = this.deps;
    const { taskId, attempt } = this.task;
    const expiresAt = new Date(clock.now().getTime() + config.leaseMs);
    const startedAt = Date.now();
    try {
      const fenced = await db.transaction(async (tx) => {
        const row = await tasks.transition(
          tx,
          { taskId, from: [running], attempt },
          { kind: 'set', fields: { leaseExpiresAt: expiresAt } },
        );
        if (row) return undefined;
        const [current] = await tx
          .select({ status: runtimeTasks.status, waitReason: runtimeTasks.waitReason })
          .from(runtimeTasks)
          .where(eq(runtimeTasks.taskId, taskId));
        return fencedSignal(current);
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
