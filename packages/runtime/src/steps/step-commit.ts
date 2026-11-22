import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  RuntimeEventTypeSchema,
  RuntimeFailureReasonSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { Db, RuntimeTrackersRepository } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { CrashPoints } from '../crash-points';
import { RuntimeError } from '../errors';
import { EventLog, upperEventProblem } from '../events/event-log';
import type {
  TaskFailure,
  TaskFields,
  TaskRow,
} from '../tasks/guarded-transition';
import { isFinished } from '../tasks/guarded-transition';
import { endTask, type TaskEndDeps, writeHeld } from '../tasks/task-end';
import {
  type ChildTask,
  type EnqueueMessage,
  type EnqueuedMessage,
  type LiveTask,
  type OpenedTracker,
  type StepEffects,
  type StepResult,
  TRACKER_MAX_TASKS,
} from './step-contract';
import { HandlerRegistry } from './handler.registry';
import { Decisions } from '../messaging/decisions';
import {
  Inbox,
  jsonByteLength,
  payloadTooLarge,
  reservedKindProblem,
} from '../messaging/inbox';
import type { RuntimeConfig } from '../runtime-config';
import { RUNTIME_CONFIG } from '../runtime.tokens';
import { Tasks } from '../tasks/tasks';
import type { TaskStepContext } from './step-context';

const { queued, running, completed, failed } = TaskStatusSchema.enum;
const { messages, decision, tasks: tasksReason } = WaitReasonSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/** Retries of a failed commit transaction; then the step is left to the recovery sweeper (Flow 1). */
const COMMIT_RETRIES = 3;

/** Services of the step's commit. */
interface StepCommitDeps extends TaskEndDeps {
  db: Db;
  handlers: HandlerRegistry;
  decisions: Decisions;
  crashPoints: CrashPoints;
  /** `INBOX_PAYLOAD_MAX_BYTES`: bound of a message payload, a `result` and a failure. */
  inboxPayloadMaxBytes: number;
}

/**
 * How the commit of a step ended: `committed`; `rejected` — the attempt is not current, nothing
 * written; `invalid` — the result broke a rule, nothing of it written, the task `failed` with
 * `invalid_step_result`; `abandoned` — the transaction failed every retry, the step is left to the
 * recovery sweeper.
 */
export type StepCommitOutcome = 'committed' | 'rejected' | 'invalid' | 'abandoned';

/** An object handed over with `effects.adopt` for a task the commit spawned. */
export interface AdoptedTask {
  readonly taskId: string;
  readonly object: LiveTask;
}

/** What `StepCommitter.commit` answers. */
export interface StepCommit {
  readonly outcome: StepCommitOutcome;
  /** The committed step finished the task (`complete`, `fail`). */
  readonly ended: boolean;
  /** Objects adopted by the transaction that committed; empty for any other outcome. */
  readonly adopted: readonly AdoptedTask[];
}

const notCommitted = (
  outcome: Exclude<StepCommitOutcome, 'committed'>,
): StepCommit => ({ outcome, ended: false, adopted: [] });

/** A step result that breaks a rule of the runtime; the commit rolls back. */
class InvalidStepResultError extends Error {
  override readonly name = 'InvalidStepResultError';
}

/**
 * What a step's `commit` left besides its writes: a broken rule, the tracker it opened, the objects
 * it handed over. One per run of the commit transaction: a retry or a rollback drops it.
 */
interface EffectsState {
  problem: string | undefined;
  tracker: OpenedTracker | undefined;
  adopted: AdoptedTask[];
}

/** What one run of the commit transaction wrote. */
interface CommittedStep {
  row: TaskRow;
  tracker: OpenedTracker | undefined;
  adopted: readonly AdoptedTask[];
}

/** The attempt is no longer current when the commit takes the task row. */
const REJECTED = Symbol('rejected');

const OUTCOMES = new Set(['continue', 'wait', 'await_decision', 'complete', 'fail']);

/** The outcome a handler returned, read defensively: the result comes from upper-layer code. */
const outcomeOf = (result: unknown): unknown =>
  (result as { outcome?: unknown } | null | undefined)?.outcome;

/** Commits a step's result: the one transaction that fixes a step entirely (KD-2, Flow 1). */
@Injectable()
export class StepCommitter {
  private readonly deps: StepCommitDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTrackersRepository) trackers: RuntimeTrackersRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(Inbox) inbox: Inbox,
    @Inject(Decisions) decisions: Decisions,
    @Inject(HandlerRegistry) handlers: HandlerRegistry,
    @Inject(CrashPoints) crashPoints: CrashPoints,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
  ) {
    this.deps = {
      db,
      tasks,
      trackers,
      events,
      inbox,
      decisions,
      handlers,
      crashPoints,
      inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    };
  }

  async commit(step: TaskStepContext, result: StepResult): Promise<StepCommit> {
    const { crashPoints } = this.deps;
    const logger = step.logger;
    crashPoints.hit('step.before-commit');
    for (let attempt = 0; attempt <= COMMIT_RETRIES; attempt += 1) {
      const startedAt = Date.now();
      try {
        const outcome = await this.commitOnce(step, result);
        const durationMs = Date.now() - startedAt;
        if (outcome === REJECTED) {
          logger.warn('step result rejected: the attempt is no longer current', {
            outcome: outcomeOf(result),
            durationMs,
          });
          return notCommitted('rejected');
        }
        crashPoints.hit('step.after-commit');
        logger.info('step committed', {
          outcome: result.outcome,
          status: outcome.row.status,
          messageIds: step.messageIds,
          ...(outcome.tracker && {
            trackerId: outcome.tracker.trackerId,
            trackerTaskIds: outcome.tracker.taskIds,
          }),
          ...(outcome.adopted.length > 0 && {
            adoptedTaskIds: outcome.adopted.map((adopted) => adopted.taskId),
          }),
          durationMs,
        });
        return {
          outcome: 'committed',
          ended: isFinished(outcome.row.status),
          adopted: outcome.adopted,
        };
      } catch (error) {
        if (error instanceof InvalidStepResultError || error instanceof RuntimeError) {
          return notCommitted(await this.failInvalid(step, error, Date.now() - startedAt));
        }
        logger.warn('step commit transaction failed', {
          outcome: outcomeOf(result),
          commitTry: attempt + 1,
          durationMs: Date.now() - startedAt,
          error,
        });
      }
    }
    logger.error('step commit abandoned to the recovery sweeper', {
      outcome: outcomeOf(result),
      retries: COMMIT_RETRIES,
    });
    return notCommitted('abandoned');
  }

  private commitOnce(
    step: TaskStepContext,
    result: StepResult,
  ): Promise<CommittedStep | typeof REJECTED> {
    const { db, tasks, inbox, decisions, events, crashPoints } = this.deps;
    return db.transaction(async () => {
      // The step's first write is of its own row: a stop, an interrupt or a message of this task
      // comes entirely before this commit or entirely after it.
      const task = await tasks.hold({ taskId: step.taskId, from: [running], attempt: step.attempt });
      if (!task) return REJECTED;
      this.checkOutcome(result);

      let tracker: OpenedTracker | undefined;
      // Collected by this run of the transaction only: a retry starts from none.
      let adopted: readonly AdoptedTask[] = [];
      if (result.commit) {
        const effects = this.effects(task, result.outcome);
        await result.commit(effects.api);
        if (effects.state.problem !== undefined) {
          throw new InvalidStepResultError(effects.state.problem);
        }
        tracker = effects.state.tracker;
        adopted = effects.state.adopted;
      }
      crashPoints.hit('step.inside-commit');
      await inbox.markDelivered(task, step.messageIds, step.stepNo);
      if (step.decision) {
        await decisions.markDelivered(step.decision.decisionId, step.stepNo);
      }

      const stepFields: TaskFields = {
        stepNo: task.stepNo + 1,
        stepClaims: 0,
        recoveries: 0,
      };
      const committedEvent = async (row: TaskRow) => {
        await events.append({
          type: EVENT['task.step_committed'],
          task: row,
          payload: {
            stepNo: step.stepNo,
            attempt: step.attempt,
            outcome: result.outcome,
            // `inbox.delivered` names the messages; a count keeps this payload small.
            messages: step.messageIds.length,
          },
        });
      };

      if (result.outcome === 'complete' || result.outcome === 'fail') {
        // The step counters go with the final status; the step event precedes the status event.
        await committedEvent({ ...task, stepNo: task.stepNo + 1 });
        const ended = await endTask(this.deps, task, {
          status: result.outcome === 'complete' ? completed : failed,
          result: result.outcome === 'complete' ? result.result : undefined,
          failure:
            result.outcome === 'fail'
              ? { reason: result.reason, message: result.message }
              : undefined,
          fields: stepFields,
        });
        return { row: ended, tracker, adopted };
      }

      if (tracker) {
        // KD-3: only the tracker's `tasks_finished` wakes the task; messages pending now or
        // arriving meanwhile come with it to the next step.
        const row = await writeHeld(tasks, task, {
          kind: 'wait',
          reason: tasksReason,
          fields: stepFields,
        });
        await committedEvent(row);
        await events.append({
          type: EVENT['task.waiting'],
          task: row,
          payload: { reason: tasksReason, trackerId: tracker.trackerId },
        });
        return { row, tracker, adopted };
      }

      if (result.outcome === 'await_decision') {
        // Messages that arrive meanwhile wait: the decision wakes the task, and its next step
        // receives them with the decision (Flow 3).
        const row = await writeHeld(tasks, task, {
          kind: 'wait',
          reason: decision,
          fields: stepFields,
        });
        await committedEvent(row);
        const request = await decisions.open(row, {
          kind: result.kind,
          payload: result.payload,
        });
        await events.append({
          type: EVENT['task.waiting'],
          task: row,
          payload: { reason: decision, decisionId: request.decisionId },
        });
        return { row, tracker, adopted };
      }

      const pending = await inbox.loadPending(task.taskId);
      const waits = result.outcome === 'wait' && pending.length === 0;
      const row = await writeHeld(
        tasks,
        task,
        waits
          ? { kind: 'wait', reason: messages, fields: stepFields }
          : { kind: 'set', status: queued, fields: stepFields },
      );
      await committedEvent(row);
      await events.append({
        type: waits ? EVENT['task.waiting'] : EVENT['task.queued'],
        task: row,
        payload: waits
          ? { reason: messages }
          : { cause: 'step', outcome: result.outcome, from: running },
      });
      return { row, tracker, adopted };
    });
  }

  /** The checks of the result itself; a broken one rolls the commit back. */
  private checkOutcome(result: StepResult): void {
    const outcome = outcomeOf(result);
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      throw new InvalidStepResultError('the step returned no known outcome');
    }
    const max = this.deps.inboxPayloadMaxBytes;
    switch (result.outcome) {
      case 'await_decision': {
        if (typeof result.kind !== 'string' || result.kind.length === 0) {
          throw new InvalidStepResultError('await_decision needs a non-empty string kind');
        }
        const bytes = jsonByteLength(result.payload ?? null);
        if (bytes > max) {
          throw new InvalidStepResultError(`decision payload is ${bytes} bytes, over ${max}`);
        }
        return;
      }
      case 'complete': {
        const bytes = jsonByteLength(result.result ?? null);
        if (bytes > max) {
          throw new InvalidStepResultError(`result is ${bytes} bytes, over ${max}`);
        }
        return;
      }
      case 'fail': {
        if (typeof result.reason !== 'string' || typeof result.message !== 'string') {
          throw new InvalidStepResultError('fail needs a string reason and message');
        }
        const bytes = jsonByteLength({ reason: result.reason, message: result.message });
        if (bytes > max) {
          throw new InvalidStepResultError(`failure is ${bytes} bytes, over ${max}`);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * The runtime writes a step's `commit` may add. A broken rule is remembered and thrown, so the
   * result is invalid even when the handler catches the error.
   */
  private effects(
    task: TaskRow,
    outcome: StepResult['outcome'],
  ): { api: StepEffects; state: EffectsState } {
    const { handlers, tasks, trackers, events, inbox, inboxPayloadMaxBytes } = this.deps;
    const state: EffectsState = { problem: undefined, tracker: undefined, adopted: [] };
    /** Tasks this commit created, with their types. */
    const spawned = new Map<string, string>();
    const invalid = (problem: string): never => {
      state.problem ??= problem;
      throw new InvalidStepResultError(problem);
    };
    /** The child's input as its handler parsed it. */
    const checkChild = ({ type, input }: ChildTask): ChildTask => {
      const handler = handlers.get(type);
      if (!handler) return invalid(`unknown child task type "${type}"`);
      const parsed = handler.inputSchema.safeParse(input);
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        return invalid(
          `input of child type "${type}" rejected at ${issue.path.join('.')}: ${issue.message}`,
        );
      }
      return { type, input: parsed.data };
    };
    const insertChild = async (child: ChildTask, trackerId: string | null): Promise<string> => {
      const row = await tasks.insert({
        taskId: randomUUID(),
        type: child.type,
        ownerId: task.ownerId,
        parentId: task.taskId,
        rootId: task.rootId,
        depth: task.depth + 1,
        input: child.input,
        trackerId,
      });
      await events.append({
        type: EVENT['task.created'],
        task: row,
        payload: { type: child.type, parentId: task.taskId, depth: row.depth, trackerId },
      });
      spawned.set(row.taskId, child.type);
      return row.taskId;
    };
    const api: StepEffects = {
      spawn: (child) => insertChild(checkChild(child), null),
      openTracker: async (children) => {
        if (outcome !== 'wait') return invalid(`openTracker needs the outcome wait, not ${outcome}`);
        if (state.tracker) return invalid('a step opens at most one tracker');
        if (!Array.isArray(children) || children.length === 0) {
          return invalid('openTracker needs at least one task');
        }
        if (children.length > TRACKER_MAX_TASKS) {
          return invalid(`openTracker got ${children.length} tasks, over ${TRACKER_MAX_TASKS}`);
        }
        const checked = children.map(checkChild);
        const trackerId = randomUUID();
        // Marked before the writes, so a second call in this commit is refused even meanwhile.
        state.tracker = { trackerId, taskIds: [] };
        await trackers.insert({ trackerId, taskId: task.taskId, ownerId: task.ownerId });
        const taskIds: string[] = [];
        for (const child of checked) taskIds.push(await insertChild(child, trackerId));
        state.tracker = { trackerId, taskIds };
        return state.tracker;
      },
      enqueue: async (message: EnqueueMessage): Promise<EnqueuedMessage> => {
        const reserved = reservedKindProblem(message.kind);
        if (reserved !== undefined) return invalid(reserved);
        const tooLarge = payloadTooLarge(message.payload, inboxPayloadMaxBytes);
        if (tooLarge) {
          state.problem ??= tooLarge.message;
          throw tooLarge;
        }
        const inserted = await inbox.insertMessage({
          recipientId: message.recipientId,
          ownerId: task.ownerId,
          kind: message.kind,
          sender: message.sender,
          payload: message.payload,
          revive: message.revive ?? false,
        });
        return { messageId: inserted.messageId, seq: inserted.seq };
      },
      emit: async (type, payload) => {
        const problem = upperEventProblem(type, payload);
        if (problem !== undefined) return invalid(problem);
        await events.appendUpper({ type, task, payload });
      },
      adopt: (taskId, object) => {
        const type = spawned.get(taskId);
        if (type === undefined) return invalid(`adopt of task ${taskId}, not spawned in this commit`);
        if (!handlers.live(type)) return invalid(`adopt of task ${taskId} of stateless type "${type}"`);
        state.adopted.push({ taskId, object });
      },
    };
    return { api, state };
  }

  /**
   * The result broke a rule: its transaction is rolled back, and a separate guarded transaction
   * fails the task with `invalid_step_result` if the attempt is still current.
   */
  private async failInvalid(
    step: TaskStepContext,
    error: Error,
    durationMs: number,
  ): Promise<Exclude<StepCommitOutcome, 'committed'>> {
    const logger: Logger = step.logger;
    const failure: TaskFailure = {
      reason: RuntimeFailureReasonSchema.enum.invalid_step_result,
      message: error.message,
    };
    let ended: boolean;
    try {
      ended = await this.deps.db.transaction(async () => {
        const task = await this.deps.tasks.hold({
          taskId: step.taskId,
          from: [running],
          attempt: step.attempt,
        });
        if (!task) return false;
        await endTask(this.deps, task, {
          status: failed,
          failure,
          fields: { stepClaims: 0, recoveries: 0 },
          fence: true,
        });
        return true;
      });
    } catch (failError) {
      logger.error('failing an invalid step result failed; left to the recovery sweeper', {
        reason: failure.reason,
        durationMs,
        error: failError,
        cause: error,
      });
      return 'abandoned';
    }
    if (!ended) {
      logger.warn('invalid step result rejected: the attempt is no longer current', {
        durationMs,
        error,
      });
      return 'rejected';
    }
    logger.error('step result invalid: task failed', {
      reason: failure.reason,
      durationMs,
      error,
    });
    return 'invalid';
  }
}
