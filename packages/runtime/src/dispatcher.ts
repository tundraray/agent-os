import { randomUUID } from 'node:crypto';
import {
  type AbortReasonKind,
  type FailureClass,
  type FailureReason,
  HandlerResultSchema,
  InvestigationStatusSchema,
  type ProposeResult,
  RuntimeEventTypeSchema,
  type RuntimeEventType,
  type TaskStatus,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { and, asc, eq, inArray, ne, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import type { RuntimeLogger } from './ports.js';
import type { RuntimeConfig } from './runtime-config.js';
import {
  type Database,
  researchEvidence,
  researchInvestigations,
  researchTaskDependencies,
  researchTasks,
} from '@agent-os/db';
import type { CancelTimer, Clock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import { EventLog, RUNTIME_NOTIFY_CHANNEL } from './event-log.js';
import { EvidenceStore } from './evidence.store.js';
import {
  type RuntimeTx,
  settleAttemptCounters,
  type TaskFields,
  type TaskRow,
  type WaitCondition,
} from './guarded-transition.js';
import {
  HandlerRegistry,
  type HandlerResult,
  type TaskHandler,
} from './handler.registry.js';
import {
  abortKindOf,
  type RunningTaskHandle,
  RunningTaskRegistry,
} from './running-task.registry.js';
import {
  AttemptContext,
  type ClaimedAttempt,
  loadUpstream,
} from './task-context.js';
import { TaskScheduler } from './task-scheduler.js';
import { checkTaskSpec } from './task-spec.js';
import { TaskRepository } from './task.repository.js';

const { queued, running, succeeded, failed, cancelled } = TaskStatusSchema.enum;
const {
  TaskStarted,
  TaskSucceeded,
  TaskFailed,
  TaskCancelled,
  TaskQueued,
  TaskWaiting,
} = RuntimeEventTypeSchema.enum;
/** Statuses that end a task; an awaited task in one of them no longer holds a waiter. */
const FINISHED: readonly TaskStatus[] = [succeeded, failed, cancelled];

/** Retries of a failed commit of the attempt's outcome; then the lease expires (Flow 3). */
const OUTCOME_COMMIT_RETRIES = 3;
/** Backoff of a worker loop doubles from `RUNTIME_POLL_MS` up to 16 × `RUNTIME_POLL_MS`. */
const MAX_BACKOFF_DOUBLINGS = 4;
/** Failure classes only the runtime writes; a handler returning one fails with `internal`. */
const RUNTIME_ONLY_CLASSES: readonly FailureClass[] = [
  'dependency_failed',
  'recovery_exhausted',
  'internal',
];
const FAILURE_MESSAGE_MAX = 2_000;
const FAILURE_CAUSE_MAX = 500;

/** Delay after the `failures`-th consecutive failure of a worker loop (1-based). */
const backoffDelay = (pollMs: number, failures: number): number =>
  pollMs * 2 ** Math.min(Math.max(failures - 1, 0), MAX_BACKOFF_DOUBLINGS);

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'Unknown';

/** A failure without its counters; the outcome write fills them from the attempt's row. */
type FailureDraft = Omit<FailureReason, 'attempt' | 'toolCalls' | 'retries'> &
  Partial<Pick<FailureReason, 'attempt' | 'toolCalls' | 'retries'>>;

/** How the attempt ended, before the guarded write applies `cancel_requested_at`. */
type AttemptOutcome =
  | { kind: 'succeeded'; result: HandlerResult }
  /** `failed`, or `cancelled` for the class `cancelled`. */
  | { kind: 'failed'; failure: FailureDraft }
  /** Regular return to `queued` on shutdown. */
  | { kind: 'released' }
  /** `waiting` on the tasks of `waitFor`, whose edges `registerWait` recorded. */
  | { kind: 'wait'; waitFor: string[] }
  /** The lease is lost: nothing is written. */
  | { kind: 'dropped' };

/** What `TaskHandler.run` did before the outcome is decided. */
type Execution =
  | { kind: 'returned'; value: unknown }
  | { kind: 'threw'; error: unknown }
  | { kind: 'aborted'; reason: AbortReasonKind };

/** The write that ends the attempt: target status, columns and event. */
interface OutcomeWrite {
  target:
    | { kind: 'set'; status: Exclude<TaskStatus, 'running' | 'waiting'> }
    | { kind: 'wait'; waitCondition: WaitCondition };
  fields: TaskFields;
  event: RuntimeEventType;
  payload: Record<string, string | number | null>;
  payloadRef?: string;
}

const runtimeFailure = (
  failureClass: FailureClass,
  code: string,
  message: string,
  cause: string | null = null,
): FailureDraft => ({
  class: failureClass,
  code,
  message: message.slice(0, FAILURE_MESSAGE_MAX),
  cause: cause?.slice(0, FAILURE_CAUSE_MAX) ?? null,
});

/**
 * The failure every task of a cancelled investigation ends with (status `cancelled`), whoever
 * writes it: the cancel itself, the attempt's outcome under `cancel_requested_at`, or the reaper.
 */
export const CANCEL_REQUESTED_FAILURE = {
  class: 'cancelled',
  code: 'cancel_requested',
  message: 'The investigation was cancelled',
  cause: null,
} as const satisfies FailureDraft;

/** `TaskCancelled` payload of a task ended by a cancel (no dependency caused it). */
export const CANCELLED_EVENT_PAYLOAD = {
  failureClass: CANCEL_REQUESTED_FAILURE.class,
  dependencyTaskId: null,
  rootCauseTaskId: null,
} as const;

/**
 * Outcome of an execution (Data Contract, Dispatcher: итог попытки). An abort decides regardless
 * of the handler's result or exception: `deadline` fails with class `deadline`, `cancelled`
 * cancels, `shutdown` releases to `queued`, `lease_lost` writes nothing.
 */
function decideOutcome(execution: Execution): AttemptOutcome {
  switch (execution.kind) {
    case 'aborted':
      return outcomeOfAbort(execution.reason);
    case 'threw':
      return {
        kind: 'failed',
        failure: runtimeFailure(
          'internal',
          'handler_exception',
          execution.error instanceof Error
            ? execution.error.message
            : String(execution.error),
          errorName(execution.error),
        ),
      };
    case 'returned':
      return outcomeOfResult(execution.value);
  }
}

function outcomeOfAbort(reason: AbortReasonKind): AttemptOutcome {
  switch (reason) {
    case 'lease_lost':
      return { kind: 'dropped' };
    case 'shutdown':
      return { kind: 'released' };
    case 'deadline':
      return {
        kind: 'failed',
        failure: runtimeFailure(
          'deadline',
          'deadline_exceeded',
          'The task ran past its deadline',
        ),
      };
    case 'cancelled':
      return { kind: 'failed', failure: CANCEL_REQUESTED_FAILURE };
  }
}

function outcomeOfResult(value: unknown): AttemptOutcome {
  const parsed = HandlerResultSchema.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      kind: 'failed',
      failure: runtimeFailure(
        'internal',
        'invalid_handler_result',
        `Invalid HandlerResult at ${issue.path.join('.')}: ${issue.message}`,
      ),
    };
  }
  const result = parsed.data;
  switch (result.kind) {
    case 'completed':
      return { kind: 'succeeded', result };
    case 'failed': {
      // The schema requires `failure` for kind `failed`.
      const failure = result.failure as FailureReason;
      if (RUNTIME_ONLY_CLASSES.includes(failure.class)) {
        return {
          kind: 'failed',
          failure: runtimeFailure(
            'internal',
            'runtime_only_failure_class',
            `A handler may not end a task with class ${failure.class}`,
          ),
        };
      }
      return { kind: 'failed', failure };
    }
    case 'wait':
      // The schema requires a non-empty `waitFor` for kind `wait`.
      return { kind: 'wait', waitFor: [...new Set(result.waitFor)] };
  }
}

/** Resolves when the signal is aborted. */
const whenAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * Execution of tasks (Flow 2). A tick — at least every `RUNTIME_POLL_MS`, sooner on `NOTIFY` or
 * when a slot frees — claims ready tasks while slots (`RUNTIME_CONCURRENCY`) are free: `queued`,
 * investigation `active`, type and version registered here, no `depends_on` edge to a task not
 * `succeeded`; `FOR UPDATE OF … SKIP LOCKED`, lease, `TaskStarted`. Each attempt runs its handler
 * outside any transaction with an `AbortSignal` (deadline, heartbeat, shutdown) and ends with
 * one guarded write of its outcome and event.
 */
export class Dispatcher {
  /** `lease_owner` of this process's claims. */
  private readonly workerId = randomUUID();
  private started = false;
  /** Slots taken by claims in flight and running attempts. */
  private busySlots = 0;
  private readonly attempts = new Set<Promise<void>>();
  private cancelTick: CancelTimer | undefined;
  private tickInFlight: Promise<void> | undefined;
  private tickRequested = false;
  private loopFailures = 0;
  private listener: pg.PoolClient | undefined;

  constructor(
    private readonly db: Database,
    private readonly pool: pg.Pool,
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly logger: RuntimeLogger,
    private readonly handlers: HandlerRegistry,
    private readonly tasks: TaskRepository,
    private readonly events: EventLog,
    private readonly evidence: EvidenceStore,
    private readonly scheduler: TaskScheduler,
    private readonly registry: RunningTaskRegistry,
    private readonly crashPoints: CrashPoints,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /**
   * Stops claiming, aborts the running attempts with `shutdown` and waits for their outcome
   * writes (each waits for its handler at most `RUNTIME_SHUTDOWN_GRACE_MS`), then stops
   * listening. The pool is closed only afterwards (KD-7).
   */
  async shutdown(): Promise<void> {
    this.started = false;
    this.cancelTick?.();
    this.cancelTick = undefined;
    await this.tickInFlight;
    await this.registry.abortAll('shutdown');
    await Promise.all(this.attempts);
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
    this.cancelTick = this.clock.setTimer(delayMs, () => {
      this.cancelTick = undefined;
      this.tickInFlight = this.tick().finally(() => {
        this.tickInFlight = undefined;
      });
    });
  }

  private async tick(): Promise<void> {
    let delay = this.config.pollMs;
    try {
      await this.listen();
      await this.claimFreeSlots();
      this.loopFailures = 0;
    } catch (error) {
      this.loopFailures += 1;
      delay = backoffDelay(this.config.pollMs, this.loopFailures);
      this.logger.error(
        `dispatcher tick failed error=${errorName(error)} retryInMs=${delay}`,
      );
    }
    if (!this.started) return;
    if (this.tickRequested && this.loopFailures === 0) delay = 0;
    this.tickRequested = false;
    this.schedule(delay);
  }

  private async claimFreeSlots(): Promise<void> {
    while (this.started && this.busySlots < this.config.concurrency) {
      this.busySlots += 1;
      let claimed: ClaimedTask | undefined;
      try {
        claimed = await this.claimNext();
      } finally {
        if (!claimed) this.busySlots -= 1;
      }
      if (!claimed) return;
      this.track(this.runAttempt(claimed));
    }
  }

  private track(attempt: Promise<void>): void {
    this.attempts.add(attempt);
    void attempt.finally(() => {
      this.attempts.delete(attempt);
      this.busySlots -= 1;
      this.wake();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------------------------

  /** Claims one ready task: one transaction, `TaskStarted` included. */
  private async claimNext(): Promise<ClaimedTask | undefined> {
    const workflows = await this.registeredQueuedWorkflows();
    if (workflows.length === 0) return undefined;
    const claimed = await this.db.transaction(async (tx) => {
      const taskId = await this.lockReadyTask(tx, workflows);
      if (!taskId) return undefined;
      const now = this.clock.now();
      const row = await this.tasks.transition(
        tx,
        { taskId, from: [queued] },
        {
          kind: 'claim',
          leaseOwner: this.workerId,
          leaseExpiresAt: new Date(now.getTime() + this.config.leaseMs),
          now,
        },
      );
      if (!row) {
        throw new Error(`Locked ready task ${taskId} refused its claim`);
      }
      const upstream = await loadUpstream(tx, taskId);
      await this.events.append(tx, {
        type: TaskStarted,
        investigationId: row.investigationId,
        taskId,
        causationId: await this.events.causeOf(tx, {
          type: TaskStarted,
          taskId,
          dependencyTaskIds: upstream
            .filter((task) => task.kind === 'depends_on')
            .map((task) => task.taskId),
        }),
        stateRevision: row.stateVersion,
        payload: { attempt: row.attempt },
      });
      return { row, upstream };
    });
    if (claimed) this.crashPoints.hit('dispatch.after-claim');
    return claimed;
  }

  /** Types and versions with `queued` tasks that this process has handlers for. */
  private async registeredQueuedWorkflows(): Promise<WorkflowKey[]> {
    const rows = await this.db
      .selectDistinct({
        workflowType: researchTasks.workflowType,
        workflowVersion: researchTasks.workflowVersion,
      })
      .from(researchTasks)
      .where(eq(researchTasks.status, queued));
    return rows.filter(
      (row) =>
        this.handlers.get(row.workflowType, row.workflowVersion) !== undefined,
    );
  }

  /**
   * The readiness query (Data Model), locking the oldest ready task FOR UPDATE OF it SKIP
   * LOCKED. The task table is aliased: `FOR UPDATE OF` takes an unqualified relation name.
   */
  private async lockReadyTask(
    tx: RuntimeTx,
    workflows: readonly WorkflowKey[],
  ): Promise<string | undefined> {
    const candidate = alias(researchTasks, 'candidate');
    const dependency = alias(researchTasks, 'dependency');
    const unfinishedDependency = tx
      .select({ one: sql`1` })
      .from(researchTaskDependencies)
      .innerJoin(
        dependency,
        eq(dependency.taskId, researchTaskDependencies.dependsOnTaskId),
      )
      .where(
        and(
          eq(researchTaskDependencies.taskId, candidate.taskId),
          eq(researchTaskDependencies.kind, 'depends_on'),
          ne(dependency.status, succeeded),
        ),
      );
    const [ready] = await tx
      .select({ taskId: candidate.taskId })
      .from(candidate)
      .innerJoin(
        researchInvestigations,
        eq(researchInvestigations.investigationId, candidate.investigationId),
      )
      .where(
        and(
          eq(candidate.status, queued),
          eq(
            researchInvestigations.status,
            InvestigationStatusSchema.enum.active,
          ),
          or(
            ...workflows.map((workflow) =>
              and(
                eq(candidate.workflowType, workflow.workflowType),
                eq(candidate.workflowVersion, workflow.workflowVersion),
              ),
            ),
          ),
          notExists(unfinishedDependency),
        ),
      )
      .orderBy(asc(candidate.createdAt), asc(candidate.taskId))
      .limit(1)
      .for('update', { of: candidate, skipLocked: true });
    return ready?.taskId;
  }

  // ---------------------------------------------------------------------------------------------
  // Attempt
  // ---------------------------------------------------------------------------------------------

  /** Runs the claimed attempt to its outcome write; never rejects. */
  private async runAttempt(claimed: ClaimedTask): Promise<void> {
    const { row } = claimed;
    const handle = this.registry.register(row);
    const stopTimers = this.armTimers(row, handle);
    try {
      const handler = this.handlers.get(row.workflowType, row.workflowVersion);
      const execution = handler
        ? await this.execute(handler, { ...claimed, signal: handle.signal })
        : {
            kind: 'threw' as const,
            error: new Error('Handler is no longer registered'),
          };
      stopTimers();
      await this.settle(row, decideOutcome(execution));
    } catch (error) {
      this.logger.error(
        `attempt failed investigationId=${row.investigationId} taskId=${row.taskId} attempt=${row.attempt} error=${errorName(error)}`,
      );
    } finally {
      stopTimers();
      handle.release();
    }
  }

  /**
   * The handler's run raced against the attempt's abort. An abort wins over a result that has not
   * been written yet; on `shutdown` the handler gets up to `RUNTIME_SHUTDOWN_GRACE_MS` to stop.
   */
  private async execute(
    handler: TaskHandler,
    claimed: ClaimedAttempt,
  ): Promise<Execution> {
    const ctx = new AttemptContext(
      {
        db: this.db,
        tasks: this.tasks,
        events: this.events,
        evidence: this.evidence,
        scheduler: this.scheduler,
        crashPoints: this.crashPoints,
        logger: this.logger,
        leaseMs: this.config.leaseMs,
      },
      claimed,
    );
    const run = Promise.resolve()
      .then(() => handler.run(ctx))
      .then(
        (value): Execution => ({ kind: 'returned', value }),
        (error: unknown): Execution => ({ kind: 'threw', error }),
      );
    const first = await Promise.race([run, whenAborted(claimed.signal)]);
    const reason = abortKindOf(claimed.signal);
    if (reason === undefined && first) return first;
    if (reason === 'shutdown') await this.withinGrace(run);
    return { kind: 'aborted', reason: reason ?? 'lease_lost' };
  }

  private async withinGrace(run: Promise<unknown>): Promise<void> {
    let cancel: CancelTimer | undefined;
    const grace = new Promise<void>((resolve) => {
      cancel = this.clock.setTimer(this.config.shutdownGraceMs, resolve);
    });
    try {
      await Promise.race([run, grace]);
    } finally {
      cancel?.();
    }
  }

  /** Deadline timer and heartbeat of the attempt; returns their idempotent stop. */
  private armTimers(row: TaskRow, handle: RunningTaskHandle): () => void {
    const deadlineAt = row.deadlineAt ?? this.clock.now();
    const cancelDeadline = this.clock.setTimer(
      Math.max(deadlineAt.getTime() - this.clock.now().getTime(), 0),
      () => handle.abort('deadline'),
    );
    const heartbeat = new Heartbeat(
      {
        db: this.db,
        tasks: this.tasks,
        clock: this.clock,
        config: this.config,
        logger: this.logger,
      },
      row,
      handle,
    );
    heartbeat.start();
    return () => {
      cancelDeadline();
      heartbeat.stop();
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Outcome
  // ---------------------------------------------------------------------------------------------

  /** Writes the outcome, retrying a failed commit; after the retries the lease expires (Flow 3). */
  private async settle(row: TaskRow, outcome: AttemptOutcome): Promise<void> {
    const context = `investigationId=${row.investigationId} taskId=${row.taskId} attempt=${row.attempt}`;
    if (outcome.kind === 'dropped') {
      this.logger.warn(`lease_lost, outcome not written ${context}`);
      return;
    }
    this.crashPoints.hit('dispatch.before-terminal');
    for (let failures = 0; ; failures += 1) {
      try {
        const written = await this.db.transaction((tx) =>
          this.writeOutcome(tx, row, outcome),
        );
        if (!written) {
          this.logger.warn(`fenced outcome ${context}`);
          return;
        }
        this.crashPoints.hit('dispatch.after-terminal');
        return;
      } catch (error) {
        this.logger.error(
          `outcome commit failed ${context} error=${errorName(error)} retry=${failures + 1}/${OUTCOME_COMMIT_RETRIES}`,
        );
        if (failures >= OUTCOME_COMMIT_RETRIES) return;
        await this.pause(backoffDelay(this.config.pollMs, failures + 1));
      }
    }
  }

  /**
   * The guarded write ending the attempt, its event and, for `proposedTasks`, their admission —
   * one transaction. Lock order: the investigation (with proposals or a wait, which reads the
   * edges `registerWait` writes under that lock), then the task. `false` when the attempt is no
   * longer the task's current one (0 rows: the result is dropped).
   */
  private async writeOutcome(
    tx: RuntimeTx,
    claimedRow: TaskRow,
    outcome: Exclude<AttemptOutcome, { kind: 'dropped' }>,
  ): Promise<boolean> {
    const proposals =
      outcome.kind === 'succeeded' ? outcome.result.proposedTasks : [];
    if (proposals.length > 0 || outcome.kind === 'wait') {
      await this.tasks.lockInvestigation(tx, claimedRow.investigationId);
    }
    const [current] = await tx
      .select()
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.taskId, claimedRow.taskId),
          eq(researchTasks.status, running),
          eq(researchTasks.attempt, claimedRow.attempt),
        ),
      )
      .for('update');
    if (!current) return false;

    const write = await this.outcomeWrite(tx, current, outcome);
    const fields: TaskFields = {
      ...settleAttemptCounters,
      ...write.fields,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    const row = await this.tasks.transition(
      tx,
      { taskId: current.taskId, from: [running], attempt: current.attempt },
      write.target.kind === 'wait'
        ? { kind: 'wait', waitCondition: write.target.waitCondition, fields }
        : { kind: 'set', status: write.target.status, fields },
    );
    if (!row) return false;

    const admitted =
      row.status === succeeded
        ? await this.admitProposals(tx, row, proposals)
        : [];
    await this.events.append(tx, {
      type: write.event,
      investigationId: row.investigationId,
      taskId: row.taskId,
      // Every event ending an attempt follows its latest EvidenceStored or TaskStarted.
      causationId: await this.events.causeOf(tx, {
        type: TaskSucceeded,
        taskId: row.taskId,
      }),
      stateRevision: row.stateVersion,
      payloadRef: write.payloadRef,
      payload:
        admitted.length > 0
          ? { ...write.payload, proposed: admitted }
          : write.payload,
    });
    return true;
  }

  /** Status, columns and event of the outcome; `cancel_requested_at` turns any outcome into `cancelled`. */
  private async outcomeWrite(
    tx: RuntimeTx,
    current: TaskRow,
    outcome: Exclude<AttemptOutcome, { kind: 'dropped' }>,
  ): Promise<OutcomeWrite> {
    if (current.cancelRequestedAt !== null) {
      return this.failureWrite(current, CANCEL_REQUESTED_FAILURE);
    }
    switch (outcome.kind) {
      case 'released':
        return {
          target: { kind: 'set', status: queued },
          fields: {},
          event: TaskQueued,
          payload: { reason: 'released' },
        };
      case 'failed':
        return this.failureWrite(current, outcome.failure);
      case 'wait':
        return this.waitWrite(tx, current, outcome.waitFor);
      case 'succeeded': {
        const foreign = await this.foreignOutputRefs(
          tx,
          current.taskId,
          outcome.result.evidenceRefs,
        );
        if (foreign.length > 0) {
          return this.failureWrite(
            current,
            runtimeFailure(
              'internal',
              'foreign_output_ref',
              `evidenceRefs ${foreign.join(', ')} are not evidence of this task`,
            ),
          );
        }
        return this.successWrite(current, outcome.result);
      }
    }
  }

  /**
   * `waiting` with its condition, or straight back to `queued` (`TaskQueued (woken)`) when every
   * awaited task has already finished (AC-RT-6) — read under the investigation lock, so a finish
   * committed later is seen by its wake-up, which takes that lock too. `waitFor` must name edges
   * recorded by `registerWait`; otherwise the result is invalid and fails with class `internal`.
   */
  private async waitWrite(
    tx: RuntimeTx,
    current: TaskRow,
    waitFor: readonly string[],
  ): Promise<OutcomeWrite> {
    const recorded = await this.scheduler.waitTargetsOf(tx, current.taskId);
    const unrecorded = waitFor.filter((id) => !recorded.has(id));
    if (unrecorded.length > 0) {
      return this.failureWrite(
        current,
        runtimeFailure(
          'internal',
          'unregistered_wait',
          `waitFor ${unrecorded.join(', ')} were not registered through registerWait`,
        ),
      );
    }
    const awaited = await tx
      .select({ status: researchTasks.status })
      .from(researchTasks)
      .where(inArray(researchTasks.taskId, [...waitFor]));
    const allFinished = awaited.every((task) =>
      FINISHED.includes(TaskStatusSchema.parse(task.status)),
    );
    if (allFinished) {
      return {
        target: { kind: 'set', status: queued },
        fields: {},
        event: TaskQueued,
        payload: { reason: 'woken' },
      };
    }
    return {
      target: { kind: 'wait', waitCondition: { waitFor: [...waitFor] } },
      fields: {},
      event: TaskWaiting,
      payload: { attempt: current.attempt, awaitedCount: waitFor.length },
    };
  }

  private successWrite(current: TaskRow, result: HandlerResult): OutcomeWrite {
    const outputRefs = [...new Set(result.evidenceRefs)];
    return {
      target: { kind: 'set', status: succeeded },
      fields: {
        // `research_tasks.outcome` holds the TaskOutcome fields and the result's coverage.
        outcome: {
          answerOrDelta: result.answerOrDelta,
          missingEvidence: result.missingEvidence,
          warnings: result.warnings,
          coverage: result.coverage,
        },
        outputRefs,
        failureReason: null,
        finishedAt: this.clock.now(),
      },
      event: TaskSucceeded,
      payloadRef: `task-outcome:${current.taskId}`,
      payload: { attempt: current.attempt, outputRefCount: outputRefs.length },
    };
  }

  /** `failed`, or `cancelled` for the class `cancelled`; counters default to the attempt's own. */
  private failureWrite(current: TaskRow, draft: FailureDraft): OutcomeWrite {
    const failure: FailureReason = {
      attempt: current.attempt,
      toolCalls: current.attemptToolCalls,
      retries: current.attemptRetries,
      ...draft,
    };
    const isCancel = failure.class === 'cancelled';
    return {
      target: { kind: 'set', status: isCancel ? cancelled : failed },
      fields: { failureReason: failure, finishedAt: this.clock.now() },
      event: isCancel ? TaskCancelled : TaskFailed,
      payload: isCancel
        ? CANCELLED_EVENT_PAYLOAD
        : {
            attempt: current.attempt,
            failureClass: failure.class,
            code: failure.code,
          },
    };
  }

  /** `evidenceRefs` that are not evidence of the task. */
  private async foreignOutputRefs(
    tx: RuntimeTx,
    taskId: string,
    evidenceRefs: readonly string[],
  ): Promise<string[]> {
    if (evidenceRefs.length === 0) return [];
    const own = await tx
      .select({ evidenceId: researchEvidence.evidenceId })
      .from(researchEvidence)
      .where(
        and(
          eq(researchEvidence.taskId, taskId),
          inArray(researchEvidence.evidenceId, [...evidenceRefs]),
        ),
      );
    const ownIds = new Set(own.map((row) => row.evidenceId));
    return evidenceRefs.filter((id) => !ownIds.has(id));
  }

  /**
   * Admission of the proposed tasks in the outcome's transaction, under the investigation lock
   * taken first; the proposing task is their requester. A refusal does not fail the outcome.
   */
  private async admitProposals(
    tx: RuntimeTx,
    row: TaskRow,
    proposals: HandlerResult['proposedTasks'],
  ): Promise<ProposalSummary[]> {
    const summaries: ProposalSummary[] = [];
    for (const proposal of proposals) {
      const checked = checkTaskSpec(proposal, this.handlers);
      const result: ProposeResult = checked.ok
        ? await this.scheduler.admit(tx, checked.spec, `task:${row.taskId}`)
        : checked.rejection;
      summaries.push(
        result.outcome === 'rejected'
          ? { outcome: result.outcome, reason: result.reason }
          : { outcome: result.outcome, taskId: result.taskId },
      );
    }
    return summaries;
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimer(ms, resolve);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // LISTEN
  // ---------------------------------------------------------------------------------------------

  /** Holds one pooled connection on `LISTEN` while `RUNTIME_NOTIFY` is on; a failure only logs. */
  private async listen(): Promise<void> {
    if (!this.config.notify || this.listener || !this.started) return;
    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      client.on('notification', () => this.wake());
      client.on('error', (error) => {
        this.logger.warn(`listen connection lost error=${errorName(error)}`);
        this.dropListener(error);
      });
      await client.query(`LISTEN "${RUNTIME_NOTIFY_CHANNEL}"`);
      this.listener = client;
    } catch (error) {
      client?.release(error instanceof Error ? error : true);
      this.logger.warn(`listen failed, polling only error=${errorName(error)}`);
    }
  }

  private dropListener(error?: Error): void {
    const client = this.listener;
    this.listener = undefined;
    // A connection that was listening goes back destroyed: it must not serve queries.
    client?.release(error ?? true);
  }
}

interface WorkflowKey {
  workflowType: string;
  workflowVersion: number;
}

type ClaimedTask = Omit<ClaimedAttempt, 'signal'>;

/** A proposed task's admission, as carried by `TaskSucceeded`. */
type ProposalSummary =
  | { outcome: 'created' | 'subscribed'; taskId: string }
  | { outcome: 'rejected'; reason: string };

interface HeartbeatDeps {
  db: Database;
  tasks: TaskRepository;
  clock: Clock;
  config: RuntimeConfig;
  logger: RuntimeLogger;
}

/**
 * Extends the attempt's lease every `RUNTIME_HEARTBEAT_MS`. 0 rows — the attempt lost the task —
 * aborts with `lease_lost`; a set `cancel_requested_at` aborts with `cancelled`. A database
 * failure retries with backoff and aborts with `lease_lost` once the lease has run out.
 */
class Heartbeat {
  private cancel: CancelTimer | undefined;
  private stopped = false;
  private failures = 0;
  private leaseExpiresAt: Date;

  constructor(
    private readonly deps: HeartbeatDeps,
    private readonly row: TaskRow,
    private readonly handle: RunningTaskHandle,
  ) {
    this.leaseExpiresAt = row.leaseExpiresAt ?? deps.clock.now();
  }

  start(): void {
    this.next(this.deps.config.heartbeatMs);
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
  }

  private next(delayMs: number): void {
    if (this.stopped || this.handle.signal.aborted) return;
    this.cancel = this.deps.clock.setTimer(delayMs, () => void this.beat());
  }

  private async beat(): Promise<void> {
    const { db, tasks, clock, config, logger } = this.deps;
    const expiresAt = new Date(clock.now().getTime() + config.leaseMs);
    try {
      const row = await db.transaction((tx) =>
        tasks.transition(
          tx,
          {
            taskId: this.row.taskId,
            from: [running],
            attempt: this.row.attempt,
          },
          { kind: 'set', fields: { leaseExpiresAt: expiresAt } },
        ),
      );
      this.failures = 0;
      if (!row) return this.handle.abort('lease_lost');
      if (row.cancelRequestedAt !== null) return this.handle.abort('cancelled');
      this.leaseExpiresAt = expiresAt;
      this.next(config.heartbeatMs);
    } catch (error) {
      this.failures += 1;
      logger.error(
        `heartbeat failed taskId=${this.row.taskId} attempt=${this.row.attempt} error=${errorName(error)}`,
      );
      if (clock.now() >= this.leaseExpiresAt)
        return this.handle.abort('lease_lost');
      this.next(backoffDelay(config.pollMs, this.failures));
    }
  }
}
