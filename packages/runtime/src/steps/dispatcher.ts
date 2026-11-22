import type { Logger } from '@agent-os/common';
import {
  RuntimeEventTypeSchema,
  RuntimeFailureReasonSchema,
  type RuntimeFailureReason,
  TaskStatusSchema,
} from '@agent-os/contracts';
import {
  DATABASE_CONNECTION,
  type DatabaseConnection,
  Db,
  type RuntimeDecisionRow,
  type RuntimeInboxRow,
  RuntimeTrackersRepository,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { CancelTimer, Clock } from '../clock';
import { CrashPoints } from '../crash-points';
import { EventLog, RUNTIME_EVENTS_CHANNEL } from '../events/event-log';
import type { TaskRow } from '../tasks/guarded-transition';
import { HandlerRegistry } from './handler.registry';
import { Heartbeat } from './heartbeat';
import { LiveTasks } from './live-tasks';
import type { StepResult, StepSignalReason } from './step-contract';
import { Decisions } from '../messaging/decisions';
import { Inbox } from '../messaging/inbox';
import type { RuntimeConfig } from '../runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import {
  type RunningStepHandle,
  RunningTaskRegistry,
} from '../tasks/running-task.registry';
import { type StepCommit, StepCommitter } from './step-commit';
import { boundTransaction, TaskStepContext } from './step-context';
import { endTask } from '../tasks/task-end';
import { Tasks } from '../tasks/tasks';
import { backoffDelay } from '../workers/worker-loop';

const { queued, running, failed } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;
const FAILURE = RuntimeFailureReasonSchema.enum;

/** Bound of a failure message the runtime writes; it travels in the parent's notice. */
const FAILURE_MESSAGE_MAX = 2_000;

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
  messages: RuntimeInboxRow[];
  decision: RuntimeDecisionRow | undefined;
}

/** A promise with its resolve, to race the shutdown against steps in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface DispatcherDeps {
  db: Db;
  /** The pool of the database: one of its connections LISTENs. */
  pool: pg.Pool;
  config: RuntimeConfig;
  clock: Clock;
  logger: Logger;
  handlers: HandlerRegistry;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  trackers: RuntimeTrackersRepository;
  events: EventLog;
  inbox: Inbox;
  decisions: Decisions;
  running: RunningTaskRegistry;
  committer: StepCommitter;
  crashPoints: CrashPoints;
  /** Objects of the tasks of live types, kept between steps. */
  live: LiveTasks;
}

/**
 * Execution of steps (Flow 1, Flow 2). A tick — at least every `RUNTIME_POLL_MS`, sooner on any
 * NOTIFY of `runtime_events` or when a slot frees — claims while slots (`RUNTIME_CONCURRENCY`) are
 * free the oldest `queued` task of a type registered here: a plain read, then the guarded claim
 * re-checks `queued`. Each step runs its handler outside any
 * transaction with a signal (step limit, heartbeat, shutdown) and ends in the commit transaction,
 * or — exception, step limit, shutdown — in a guarded write of the dispatcher that raises the
 * attempt, so that a late result and `guard` of the step are fenced (Invariant 1).
 */
@Injectable()
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
  private readonly deps: DispatcherDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
    @Inject(CLOCK) clock: Clock,
    @Inject(RUNTIME_LOGGER) logger: Logger,
    @Inject(HandlerRegistry) handlers: HandlerRegistry,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(RuntimeTrackersRepository) trackers: RuntimeTrackersRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(Inbox) inbox: Inbox,
    @Inject(Decisions) decisions: Decisions,
    @Inject(RunningTaskRegistry) running: RunningTaskRegistry,
    @Inject(StepCommitter) committer: StepCommitter,
    @Inject(CrashPoints) crashPoints: CrashPoints,
    @Inject(LiveTasks) live: LiveTasks,
  ) {
    this.deps = {
      db,
      pool: connection.pool,
      config,
      clock,
      logger: logger.child({ worker: 'dispatcher' }),
      handlers,
      tasks,
      taskRows,
      trackers,
      events,
      inbox,
      decisions,
      running,
      committer,
      crashPoints,
      live,
    };
  }

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
      this.deps.live.sweep(this.deps.clock.now());
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
    const { db, handlers, tasks, taskRows, events, inbox, decisions, clock, config, crashPoints } =
      this.deps;
    const types = handlers.types();
    if (types.length === 0) return undefined;
    const claimed = await db.transaction(async () => {
      const taskId = await taskRows.findReady(types);
      if (!taskId) return undefined;
      // The guard re-checks `queued`.
      const task = await tasks.transition(
        { taskId, from: [queued] },
        {
          kind: 'claim',
          leaseExpiresAt: new Date(clock.now().getTime() + config.leaseMs),
        },
      );
      if (!task) return undefined;
      const messages = await inbox.loadPending(taskId);
      const decision = await decisions.loadUndelivered(taskId);
      await events.append({
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
        taskRows: this.deps.taskRows,
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
    let commit: StepCommit | undefined;
    try {
      heartbeat.start();
      const execution = await this.execute(step, handle);
      await heartbeat.stop();
      commit = await this.settle(step, execution, startedAt);
    } catch (error) {
      step.logger.error('step write failed; left to lease expiry', {
        durationMs: Date.now() - startedAt,
        error,
      });
    } finally {
      await heartbeat.stop();
      // Before the release: the step holds its slot, and the shutdown waits, until the task's
      // object has taken the commit in or is let go.
      await this.deps.live.settled(step, commit);
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
    const { live, clock, config } = this.deps;
    const run: Promise<HandlerEnd> = Promise.resolve()
      // Rejects for an unregistered type and for a live task whose object could not be restored.
      .then(() => live.obtain(step, handle))
      .then((runner) => runner.step(step))
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

  /** Writes how the step ended; answers the commit of a returned result, else `undefined`. */
  private async settle(
    step: TaskStepContext,
    execution: Execution,
    startedAt: number,
  ): Promise<StepCommit | undefined> {
    switch (execution.kind) {
      case 'returned':
        return this.deps.committer.commit(step, execution.result);
      case 'threw':
        if (step.signal.aborted) {
          // The step was cut off (interrupt, stop, lost lease): its attempt is no longer current.
          step.logger.warn('step ended by its signal; nothing written', {
            signal: step.signal.reason,
            durationMs: Date.now() - startedAt,
            error: execution.error,
          });
          return undefined;
        }
        await this.failStep(step, FAILURE.handler_error, execution.error, startedAt);
        return undefined;
      case 'timed_out':
        await this.failStep(
          step,
          FAILURE.step_timeout,
          new Error(`The step ran past ${this.deps.config.stepMs} ms`),
          startedAt,
        );
        return undefined;
      case 'shut_down':
        await this.requeue(step, startedAt);
        return undefined;
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
    const { db, taskRows, config } = this.deps;
    const ended = await db.transaction(async () => {
      await boundTransaction(db, config.leaseMs);
      const task = await taskRows.find(step.taskId);
      if (task?.status !== running || task.attempt !== step.attempt) return undefined;
      return endTask(this.deps, task, {
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
    const row = await db.transaction(async () => {
      const requeued = await tasks.transition(
        { taskId: step.taskId, from: [running], attempt: step.attempt },
        { kind: 'set', status: queued, fence: true },
      );
      if (!requeued) return undefined;
      await events.append({
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
    const current = await this.deps.taskRows.find(notice.taskId);
    // Not awaited: the steps end when their handlers answer the signal.
    void this.deps.running.abortTask(notice.taskId, reason, current?.attempt);
    this.deps.live.evict([notice.taskId]);
  }

  private dropListener(error?: Error): void {
    const client = this.listener;
    this.listener = undefined;
    // A connection that was listening goes back destroyed: it must not serve queries.
    client?.release(error ?? true);
  }
}
