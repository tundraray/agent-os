import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  CHILD_FINISHED_KIND,
  RuntimeEventTypeSchema,
  RuntimeFailureReasonSchema,
  TaskStatusSchema,
  MessageStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type Database, runtimeInbox } from '@agent-os/db';
import { and, eq } from 'drizzle-orm';
import type { CrashPoints } from './crash-points.js';
import { RuntimeError } from './errors.js';
import { type EventLog, upperEventProblem } from './event-log.js';
import type {
  TaskChange,
  TaskFields,
  TaskRow,
} from './guarded-transition.js';
import type {
  EnqueueMessage,
  EnqueuedMessage,
  HandlerRegistry,
  StepEffects,
  StepResult,
} from './handler.registry.js';
import type { Decisions } from './decisions.js';
import { type Inbox, jsonByteLength, payloadTooLarge } from './inbox.js';
import { retryingTransaction, type RuntimeTx } from './runtime-tx.js';
import { boundTransaction, type TaskStepContext } from './step-context.js';
import type { TaskRepository } from './task.repository.js';

const { queued, running, completed, failed, stopped } = TaskStatusSchema.enum;
const { messages, decision } = WaitReasonSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/** Retries of a failed commit transaction; then the step is left to its lease expiry (Flow 1). */
const COMMIT_RETRIES = 3;
/** Bound of a failure message in an event payload, which is at most 8 KiB. */
const EVENT_MESSAGE_MAX = 1_000;

/** Why a failed task failed: a runtime reason (`handler_error`, …) or the upper layer's own. */
export interface TaskFailure {
  reason: string;
  message: string;
}

/** Services the end of a task writes through. */
export interface TaskEndDeps {
  tasks: TaskRepository;
  events: EventLog;
  inbox: Inbox;
}

/** How a task ends. */
export interface TaskEnd {
  status: typeof completed | typeof failed | typeof stopped;
  /** The outcome of a `completed` task. */
  result?: unknown;
  /** The reason of a `failed` task. */
  failure?: TaskFailure;
  /** Further columns of the same write, e.g. the step counters. */
  fields?: TaskFields;
  /** `attempt + 1`: the step in flight, if any, is no longer current (Invariant 1). */
  fence?: boolean;
}

const STATUS_EVENT = {
  completed: EVENT['task.completed'],
  failed: EVENT['task.failed'],
  stopped: EVENT['task.stopped'],
} as const;

const eventFailure = (failure: TaskFailure): TaskFailure => ({
  reason: failure.reason,
  message: failure.message.slice(0, EVENT_MESSAGE_MAX),
});

/** A guarded write of a task whose row the caller holds FOR UPDATE; it cannot be fenced then. */
export async function writeLocked(
  tx: RuntimeTx,
  tasks: TaskRepository,
  task: TaskRow,
  change: TaskChange,
): Promise<TaskRow> {
  const row = await tasks.transition(
    tx,
    {
      taskId: task.taskId,
      from: [TaskStatusSchema.parse(task.status)],
      attempt: task.attempt,
    },
    change,
  );
  if (!row) throw new Error(`Write of locked task ${task.taskId} matched no row`);
  return row;
}

/**
 * The child's end notice in the parent's inbox (design-runtime.md, Очередь): never with `revive`,
 * so it does not wake a finished parent.
 */
async function notifyParent(
  tx: RuntimeTx,
  inbox: Inbox,
  child: TaskRow,
): Promise<void> {
  if (child.parentId === null) return;
  const finishedAt = child.finishedAt ?? new Date();
  const status = TaskStatusSchema.parse(child.status);
  await inbox.insertMessage(tx, {
    recipientId: child.parentId,
    ownerId: child.ownerId,
    kind: CHILD_FINISHED_KIND,
    sender: child.taskId,
    payload: {
      taskId: child.taskId,
      status,
      ...(status === completed && { result: child.result }),
      ...(status === failed && { failure: child.failure }),
      steps: child.stepNo,
      durationMs: finishedAt.getTime() - child.createdAt.getTime(),
    },
    revive: false,
  });
}

/** Whether a message with `revive` waits in the task's inbox. */
async function hasPendingRevive(tx: RuntimeTx, taskId: string): Promise<boolean> {
  const rows = await tx
    .select({ messageId: runtimeInbox.messageId })
    .from(runtimeInbox)
    .where(
      and(
        eq(runtimeInbox.recipientId, taskId),
        eq(runtimeInbox.status, MessageStatusSchema.enum.pending),
        eq(runtimeInbox.revive, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The one procedure "a task ends → its parent is told" (KD-3, Invariant 5), in the caller's
 * transaction and under its lock of `task`: the final status with its event, one `child_finished`
 * to the parent, and — when the task completed or failed while a message with `revive` arrived —
 * `queued` again with `task.queued` (Invariant 9). A stop never revives. Returns the last row.
 */
export async function endTask(
  tx: RuntimeTx,
  deps: TaskEndDeps,
  task: TaskRow,
  end: TaskEnd,
): Promise<TaskRow> {
  const ended = await writeLocked(tx, deps.tasks, task, {
    kind: 'set',
    status: end.status,
    fields: {
      ...end.fields,
      ...(end.status === completed && { result: end.result ?? null }),
      ...(end.status === failed && { failure: end.failure }),
    },
    fence: end.fence,
  });
  await deps.events.append(tx, {
    type: STATUS_EVENT[end.status],
    task: ended,
    payload: {
      from: task.status,
      ...(end.failure && { failure: eventFailure(end.failure) }),
    },
  });
  await notifyParent(tx, deps.inbox, ended);

  if (end.status === stopped || !(await hasPendingRevive(tx, ended.taskId))) {
    return ended;
  }
  const revived = await writeLocked(tx, deps.tasks, ended, {
    kind: 'set',
    status: queued,
    fields: { result: null, failure: null },
  });
  await deps.events.append(tx, {
    type: EVENT['task.queued'],
    task: revived,
    payload: { cause: 'revive', from: ended.status },
  });
  return revived;
}

/** Services of the step's commit. */
export interface StepCommitDeps extends TaskEndDeps {
  db: Database;
  handlers: HandlerRegistry;
  decisions: Decisions;
  crashPoints: CrashPoints;
  /** `INBOX_PAYLOAD_MAX_BYTES`: bound of a message payload, a `result` and a failure. */
  inboxPayloadMaxBytes: number;
  /** `RUNTIME_LEASE_MS`: the bound of a commit transaction. */
  leaseMs: number;
}

/**
 * How the commit of a step ended: `committed`; `rejected` — the attempt is not current, nothing
 * written; `invalid` — the result broke a rule, nothing of it written, the task `failed` with
 * `invalid_step_result`; `abandoned` — the transaction failed every retry, the step is left to its
 * lease expiry.
 */
export type StepCommitOutcome = 'committed' | 'rejected' | 'invalid' | 'abandoned';

/** A step result that breaks a rule of the runtime; the commit rolls back. */
class InvalidStepResultError extends Error {
  override readonly name = 'InvalidStepResultError';
}

/** The attempt is no longer current when the commit locks the task. */
const REJECTED = Symbol('rejected');

const OUTCOMES = new Set(['continue', 'wait', 'await_decision', 'complete', 'fail']);

/** The outcome a handler returned, read defensively: the result comes from upper-layer code. */
const outcomeOf = (result: unknown): unknown =>
  (result as { outcome?: unknown } | null | undefined)?.outcome;

/** Commits a step's result: the one transaction that fixes a step entirely (KD-2, Flow 1). */
export class StepCommitter {
  constructor(private readonly deps: StepCommitDeps) {}

  async commit(step: TaskStepContext, result: StepResult): Promise<StepCommitOutcome> {
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
          return 'rejected';
        }
        crashPoints.hit('step.after-commit');
        logger.info('step committed', {
          outcome: result.outcome,
          status: outcome.status,
          messageIds: step.messageIds,
          durationMs,
        });
        return 'committed';
      } catch (error) {
        if (error instanceof InvalidStepResultError || error instanceof RuntimeError) {
          return this.failInvalid(step, error, Date.now() - startedAt);
        }
        logger.warn('step commit transaction failed', {
          outcome: outcomeOf(result),
          commitTry: attempt + 1,
          durationMs: Date.now() - startedAt,
          error,
        });
      }
    }
    logger.error('step commit abandoned to lease expiry', {
      outcome: outcomeOf(result),
      retries: COMMIT_RETRIES,
    });
    return 'abandoned';
  }

  private commitOnce(
    step: TaskStepContext,
    result: StepResult,
  ): Promise<TaskRow | typeof REJECTED> {
    const { db, tasks, inbox, decisions, events, crashPoints, leaseMs } = this.deps;
    const outcome = outcomeOf(result);
    const endsTask = outcome === 'complete' || outcome === 'fail';
    return retryingTransaction(db, step.logger, 'step.commit', async (tx) => {
      await boundTransaction(tx, leaseMs);
      // A step that ends the task notifies its parent: the parent is locked first (Invariant 6).
      const task = endsTask
        ? await tasks.lockWithParent(tx, step.taskId)
        : await tasks.lock(tx, step.taskId);
      if (task?.status !== running || task.attempt !== step.attempt) return REJECTED;
      this.checkOutcome(result);

      if (result.commit) {
        const effects = this.effects(tx, task);
        await result.commit(tx, effects.api);
        if (effects.state.problem !== undefined) {
          throw new InvalidStepResultError(effects.state.problem);
        }
      }
      crashPoints.hit('step.inside-commit');
      await inbox.markDelivered(tx, task, step.messageIds, step.stepNo);
      if (step.decision) {
        await decisions.markDelivered(tx, step.decision.decisionId, step.stepNo);
      }

      const stepFields: TaskFields = {
        stepNo: task.stepNo + 1,
        stepClaims: 0,
        recoveries: 0,
      };
      const committedEvent = async (row: TaskRow) => {
        await events.append(tx, {
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
        return endTask(tx, this.deps, task, {
          status: result.outcome === 'complete' ? completed : failed,
          result: result.outcome === 'complete' ? result.result : undefined,
          failure:
            result.outcome === 'fail'
              ? { reason: result.reason, message: result.message }
              : undefined,
          fields: stepFields,
        });
      }

      if (result.outcome === 'await_decision') {
        // Messages that arrive meanwhile wait: the decision wakes the task, and its next step
        // receives them with the decision (Flow 3).
        const row = await writeLocked(tx, tasks, task, {
          kind: 'wait',
          reason: decision,
          fields: stepFields,
        });
        await committedEvent(row);
        const request = await decisions.open(tx, row, {
          kind: result.kind,
          payload: result.payload,
        });
        await events.append(tx, {
          type: EVENT['task.waiting'],
          task: row,
          payload: { reason: decision, decisionId: request.decisionId },
        });
        return row;
      }

      const pending = await inbox.loadPending(tx, task.taskId);
      const waits = result.outcome === 'wait' && pending.length === 0;
      const row = await writeLocked(
        tx,
        tasks,
        task,
        waits
          ? { kind: 'wait', reason: messages, fields: stepFields }
          : { kind: 'set', status: queued, fields: stepFields },
      );
      await committedEvent(row);
      await events.append(tx, {
        type: waits ? EVENT['task.waiting'] : EVENT['task.queued'],
        task: row,
        payload: waits
          ? { reason: messages }
          : { cause: 'step', outcome: result.outcome, from: running },
      });
      return row;
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
    tx: RuntimeTx,
    task: TaskRow,
  ): { api: StepEffects; state: { problem: string | undefined } } {
    const { handlers, tasks, events, inbox, inboxPayloadMaxBytes } = this.deps;
    const state: { problem: string | undefined } = { problem: undefined };
    const invalid = (problem: string): never => {
      state.problem ??= problem;
      throw new InvalidStepResultError(problem);
    };
    const api: StepEffects = {
      spawn: async ({ type, input }) => {
        const handler = handlers.get(type);
        if (!handler) return invalid(`unknown child task type "${type}"`);
        const parsed = handler.inputSchema.safeParse(input);
        if (!parsed.success) {
          const [issue] = parsed.error.issues;
          return invalid(
            `input of child type "${type}" rejected at ${issue.path.join('.')}: ${issue.message}`,
          );
        }
        const child = await tasks.insert(tx, {
          taskId: randomUUID(),
          type,
          ownerId: task.ownerId,
          parentId: task.taskId,
          rootId: task.rootId,
          depth: task.depth + 1,
          input: parsed.data,
        });
        await events.append(tx, {
          type: EVENT['task.created'],
          task: child,
          payload: { type, parentId: task.taskId, depth: child.depth },
        });
        return child.taskId;
      },
      enqueue: async (message: EnqueueMessage): Promise<EnqueuedMessage> => {
        if (message.kind === CHILD_FINISHED_KIND) {
          return invalid(`message kind "${CHILD_FINISHED_KIND}" is reserved by the runtime`);
        }
        const tooLarge = payloadTooLarge(message.payload, inboxPayloadMaxBytes);
        if (tooLarge) {
          state.problem ??= tooLarge.message;
          throw tooLarge;
        }
        const inserted = await inbox.insertMessage(tx, {
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
        await events.appendUpper(tx, { type, task, payload });
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
  ): Promise<StepCommitOutcome> {
    const logger: Logger = step.logger;
    const failure: TaskFailure = {
      reason: RuntimeFailureReasonSchema.enum.invalid_step_result,
      message: error.message,
    };
    let ended: boolean;
    try {
      ended = await retryingTransaction(this.deps.db, logger, 'step.fail-invalid', async (tx) => {
        await boundTransaction(tx, this.deps.leaseMs);
        const task = await this.deps.tasks.lockWithParent(tx, step.taskId);
        if (task?.status !== running || task.attempt !== step.attempt) return false;
        await endTask(tx, this.deps, task, {
          status: failed,
          failure,
          fields: { stepClaims: 0, recoveries: 0 },
          fence: true,
        });
        return true;
      });
    } catch (failError) {
      logger.error('failing an invalid step result failed; left to lease expiry', {
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
