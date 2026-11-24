import { randomUUID } from 'node:crypto';
import { errorText, type Logger } from '@agent-os/common';
import {
  RuntimeFailureReasonSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { Db, RuntimeTasksRepository, type RuntimeTaskRow } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { CrashPoints } from '../crash-points';
import { RuntimeError } from '../errors';
import type { TaskFailure, TaskValues } from '../tasks/guarded-transition';
import { isFinished } from '../tasks/guarded-transition';
import {
  type EndedTask,
  endTask,
  logTaskEnds,
  type TaskEndDeps,
  type TaskEndRecord,
  writeHeld,
} from '../tasks/task-end';
import {
  AWAITED_CHILDREN_MAX,
  type ChildTask,
  type EnqueueMessage,
  type EnqueuedMessage,
  type LiveTask,
  QUESTION_TASK_TYPE,
  type Question,
  type StepEffects,
  type StepResult,
} from './step-contract';
import { HandlerRegistry } from './handler.registry';
import {
  Inbox,
  jsonByteLength,
  payloadTooLarge,
  reservedKindProblem,
} from '../messaging/inbox';
import type { RuntimeConfig } from '../runtime-config';
import { RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { TaskEndHooks } from '../tasks/task-end-hooks';
import { Tasks } from '../tasks/tasks';
import { inSavepoint, withTxRetry } from '../tasks/transaction-retry';
import type { TaskStepContext } from './step-context';

const { queued, running, completed, failed } = TaskStatusSchema.enum;
const { messages, human, children: childrenReason } = WaitReasonSchema.enum;

/** Retries of a failed commit transaction; then the step is left to the recovery sweeper (Flow 1). */
const COMMIT_RETRIES = 3;

/** Services of the step's commit. */
interface StepCommitDeps extends TaskEndDeps {
  handlers: HandlerRegistry;
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
export type StepCommitOutcome =
  'committed' | 'rejected' | 'invalid' | 'abandoned';

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
  /**
   * Descendants the end of a failed task stopped (`committed` with `fail`, or `invalid`); the
   * caller cuts their steps off after the commit.
   */
  readonly stopped: readonly RuntimeTaskRow[];
}

const notCommitted = (
  outcome: Exclude<StepCommitOutcome, 'committed'>,
  stopped: readonly RuntimeTaskRow[] = [],
): StepCommit => ({ outcome, ended: false, adopted: [], stopped });

/** A step result that breaks a rule of the runtime; the commit rolls back. */
class InvalidStepResultError extends Error {
  override readonly name = 'InvalidStepResultError';
}

/**
 * What a step's `commit` left besides its writes: a broken rule, the objects it handed over, the
 * children it created. One per run of the commit transaction: a retry or a rollback drops it, and
 * a rolled-back `effects.savepoint` drops what it added.
 */
interface EffectsState {
  problem: string | undefined;
  adopted: AdoptedTask[];
  /** Children the commit created, for the log after it. */
  children: RuntimeTaskRow[];
  /** Messages the commit sent, for the log after it. */
  sent: SentMessage[];
  /** The question the commit asked, with what it asked; at most one. */
  question: AskedQuestion | undefined;
}

/** A question a step's commit asked, as its log record names it. */
interface AskedQuestion {
  questionId: string;
  kind: string;
}

/** A message a step's commit sent, as its log record names it. */
interface SentMessage {
  messageId: string;
  kind: string;
  recipientId: string;
  revive: boolean;
  recipientStatus: string;
}

/** What one run of the commit transaction wrote. */
interface CommittedStep {
  row: RuntimeTaskRow;
  adopted: readonly AdoptedTask[];
  stopped: readonly RuntimeTaskRow[];
  /** The ends the commit wrote: the task's own, then the descendants its failure stopped. */
  ends: readonly TaskEndRecord[];
  children: readonly RuntimeTaskRow[];
  sent: readonly SentMessage[];
  question: AskedQuestion | undefined;
}

/** The attempt is no longer current when the commit takes the task row. */
const REJECTED = Symbol('rejected');

const OUTCOMES = new Set(['continue', 'wait', 'complete', 'fail']);

/** The outcome a handler returned, read defensively: the result comes from upper-layer code. */
const outcomeOf = (result: unknown): unknown =>
  (result as { outcome?: unknown } | null | undefined)?.outcome;

/**
 * After the commit: «step committed» with what the transaction wrote, one record per child it
 * created, one for the question it asked and one per task it ended.
 */
function logStepCommitted(
  step: TaskStepContext,
  result: StepResult,
  committed: CommittedStep,
  durationMs: number,
): void {
  const { logger } = step;
  for (const child of committed.children) {
    logger.info('child task created in step', {
      childId: child.taskId,
      childType: child.type,
      depth: child.depth,
      awaitedStep: child.awaitedStep,
    });
  }
  const { row, question } = committed;
  if (question !== undefined) {
    logger.info('question asked', {
      questionId: question.questionId,
      kind: question.kind,
      askerId: step.taskId,
    });
  }
  logger.info('step committed', {
    outcome: result.outcome,
    from: running,
    to: row.status,
    waitReason: row.waitReason,
    deliveredMessages: step.messages.map(({ messageId, kind }) => ({
      messageId,
      kind,
    })),
    ...(committed.children.length > 0 && {
      childIds: committed.children.map((child) => child.taskId),
    }),
    ...(committed.sent.length > 0 && { sentMessages: committed.sent }),
    ...(question !== undefined && { questionId: question.questionId }),
    ...(committed.adopted.length > 0 && {
      adoptedTaskIds: committed.adopted.map((adopted) => adopted.taskId),
    }),
    ...(committed.stopped.length > 0 && {
      stoppedIds: committed.stopped.map((task) => task.taskId),
    }),
    durationMs,
  });
  logTaskEnds(logger, committed.ends);
}

/** Commits a step's result: the one transaction that fixes a step entirely (KD-2, Flow 1). */
@Injectable()
export class StepCommitter {
  private readonly deps: StepCommitDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(Inbox) inbox: Inbox,
    @Inject(TaskEndHooks) endHooks: TaskEndHooks,
    @Inject(HandlerRegistry) handlers: HandlerRegistry,
    @Inject(CrashPoints) crashPoints: CrashPoints,
    @Inject(RUNTIME_LOGGER) logger: Logger,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
  ) {
    this.deps = {
      db,
      tasks,
      taskRows,
      inbox,
      endHooks,
      logger,
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
          logger.warn(
            'step result rejected: the attempt is no longer current',
            {
              outcome: outcomeOf(result),
              durationMs,
            },
          );
          return notCommitted('rejected');
        }
        crashPoints.hit('step.after-commit');
        logStepCommitted(step, result, outcome, durationMs);
        return {
          outcome: 'committed',
          ended: isFinished(outcome.row.status),
          adopted: outcome.adopted,
          stopped: outcome.stopped,
        };
      } catch (error) {
        if (
          error instanceof InvalidStepResultError ||
          error instanceof RuntimeError
        ) {
          const failedInvalid = await this.failInvalid(
            step,
            error,
            Date.now() - startedAt,
          );
          return notCommitted(failedInvalid.outcome, failedInvalid.stopped);
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
    const { db, tasks, inbox, crashPoints } = this.deps;
    return db.transaction(async () => {
      // The step's first write is of its own row: a stop, an interrupt or a message of this task
      // comes entirely before this commit or entirely after it.
      const task = await tasks.hold({
        taskId: step.taskId,
        from: [running],
        attempt: step.attempt,
      });
      if (!task) return REJECTED;
      this.checkOutcome(result);

      // Collected by this run of the transaction only: a retry starts from none.
      const effects = this.effects(task, result.outcome);
      if (result.commit) {
        await result.commit(effects.api);
        if (effects.state.problem !== undefined) {
          throw new InvalidStepResultError(effects.state.problem);
        }
      }
      const { adopted, children, sent, question } = effects.state;
      const written: Omit<CommittedStep, 'row'> = {
        adopted,
        children,
        sent,
        question,
        stopped: [],
        ends: [],
      };
      crashPoints.hit('step.inside-commit');
      await inbox.markDelivered(task, step.messageIds);

      const stepFields: TaskValues = {
        stepNo: task.stepNo + 1,
        recoveries: 0,
      };

      if (result.outcome === 'complete' || result.outcome === 'fail') {
        // The step counters go with the final status.
        const ended = await endTask(this.deps, task, {
          status: result.outcome === 'complete' ? completed : failed,
          result: result.outcome === 'complete' ? result.result : undefined,
          failure:
            result.outcome === 'fail'
              ? { reason: result.reason, message: result.message }
              : undefined,
          fields: stepFields,
          cause: 'step',
        });
        return {
          ...written,
          row: ended.row,
          stopped: ended.stopped,
          ends: ended.ends,
        };
      }

      if (
        question !== undefined ||
        children.some((child) => child.awaitedStep !== null)
      ) {
        // KD-2, KD-3: the wake-up rule decides which `child_finished` wakes the task — of an
        // awaited child or of the question; messages pending now or arriving meanwhile come with
        // the wake-up to the next step.
        const row = await writeHeld(tasks, task, {
          kind: 'wait',
          reason: childrenReason,
          fields: stepFields,
        });
        return { ...written, row };
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
      return { ...written, row };
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
      case 'complete': {
        const bytes = jsonByteLength(result.result ?? null);
        if (bytes > max) {
          throw new InvalidStepResultError(
            `result is ${bytes} bytes, over ${max}`,
          );
        }
        return;
      }
      case 'fail': {
        if (
          typeof result.reason !== 'string' ||
          typeof result.message !== 'string'
        ) {
          throw new InvalidStepResultError(
            'fail needs a string reason and message',
          );
        }
        const bytes = jsonByteLength({
          reason: result.reason,
          message: result.message,
        });
        if (bytes > max) {
          throw new InvalidStepResultError(
            `failure is ${bytes} bytes, over ${max}`,
          );
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
    task: RuntimeTaskRow,
    outcome: StepResult['outcome'],
  ): { api: StepEffects; state: EffectsState } {
    const { db, handlers, tasks, inbox, inboxPayloadMaxBytes } = this.deps;
    const state: EffectsState = {
      problem: undefined,
      adopted: [],
      children: [],
      sent: [],
      question: undefined,
    };
    /** Set before the first write of `ask`, so a second call in parallel is refused too. */
    let asked = false;
    /** Tasks this commit created, with their types. */
    const spawned = new Map<string, string>();
    const invalid = (problem: string): never => {
      state.problem ??= problem;
      throw new InvalidStepResultError(problem);
    };
    /** Awaited children this commit created. */
    let awaitedCount = 0;
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
    /** KD-2: an awaited child only with `wait`, at most {@link AWAITED_CHILDREN_MAX} per commit. */
    const checkAwaited = (child: ChildTask): boolean => {
      if (child.awaited !== true) return false;
      if (outcome !== 'wait')
        return invalid(
          `an awaited child needs the outcome wait, not ${outcome}`,
        );
      if (awaitedCount >= AWAITED_CHILDREN_MAX) {
        return invalid(
          `a commit creates at most ${AWAITED_CHILDREN_MAX} awaited children`,
        );
      }
      awaitedCount += 1;
      return true;
    };
    const insertChild = async (child: ChildTask): Promise<string> => {
      const awaited = checkAwaited(child);
      const { type, input } = checkChild(child);
      const row = await tasks.insert({
        taskId: randomUUID(),
        type,
        ownerId: task.ownerId,
        parentId: task.taskId,
        rootId: task.rootId,
        depth: task.depth + 1,
        input,
        // The `step_no` this commit writes to the parent.
        awaitedStep: awaited ? task.stepNo + 1 : null,
      });
      spawned.set(row.taskId, type);
      state.children.push(row);
      return row.taskId;
    };
    /** KD-3: only with `wait`, one per commit, the payload within `INBOX_PAYLOAD_MAX_BYTES`. */
    const checkQuestion = (question: Question): Question => {
      if (outcome !== 'wait')
        return invalid(`a question needs the outcome wait, not ${outcome}`);
      if (asked) return invalid('a commit asks at most one question');
      const kind = (question as Partial<Question> | null | undefined)?.kind;
      if (typeof kind !== 'string' || kind.length === 0)
        return invalid('a question needs a non-empty string kind');
      const payload = question.payload ?? null;
      const bytes = jsonByteLength(payload);
      if (bytes > inboxPayloadMaxBytes) {
        return invalid(
          `question payload is ${bytes} bytes, over ${inboxPayloadMaxBytes}`,
        );
      }
      return { kind, payload };
    };
    const insertQuestion = async (question: Question): Promise<string> => {
      const input = checkQuestion(question);
      asked = true;
      const inserted = await tasks.insert({
        taskId: randomUUID(),
        type: QUESTION_TASK_TYPE,
        ownerId: task.ownerId,
        parentId: task.taskId,
        rootId: task.rootId,
        depth: task.depth + 1,
        input,
        // Awaited as a child: the `step_no` this commit writes to the parent.
        awaitedStep: task.stepNo + 1,
      });
      // Created waiting for its answer; no handler ever claims it.
      const row = await writeHeld(tasks, inserted, {
        kind: 'wait',
        reason: human,
      });
      state.question = { questionId: row.taskId, kind: input.kind };
      return row.taskId;
    };
    const api: StepEffects = {
      spawn: (child) => insertChild(child),
      ask: (question) => insertQuestion(question),
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
          payload: message.payload,
          revive: message.revive ?? false,
        });
        state.sent.push({
          messageId: inserted.messageId,
          kind: message.kind,
          recipientId: message.recipientId,
          revive: message.revive ?? false,
          recipientStatus: inserted.recipient.status,
        });
        return { messageId: inserted.messageId, seq: inserted.seq };
      },
      adopt: (taskId, object) => {
        const type = spawned.get(taskId);
        if (type === undefined)
          return invalid(`adopt of task ${taskId}, not spawned in this commit`);
        if (!handlers.live(type))
          return invalid(`adopt of task ${taskId} of stateless type "${type}"`);
        state.adopted.push({ taskId, object });
      },
      savepoint: async (fn) => {
        // What the effects collected before the savepoint; its rollback drops the rest with the rows.
        const before = {
          adopted: state.adopted.length,
          children: state.children.length,
          sent: state.sent.length,
          question: state.question,
          asked,
          awaitedCount,
          spawned: new Map(spawned),
        };
        const outcome = await inSavepoint(db, fn);
        if (outcome.ok) return outcome;
        state.adopted.length = before.adopted;
        state.children.length = before.children;
        state.sent.length = before.sent;
        state.question = before.question;
        asked = before.asked;
        awaitedCount = before.awaitedCount;
        spawned.clear();
        for (const [taskId, type] of before.spawned) spawned.set(taskId, type);
        return outcome;
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
  ): Promise<{
    outcome: Exclude<StepCommitOutcome, 'committed'>;
    stopped: readonly RuntimeTaskRow[];
  }> {
    const logger: Logger = step.logger;
    const failure: TaskFailure = {
      reason: RuntimeFailureReasonSchema.enum.invalid_step_result,
      message: errorText(error),
    };
    let ended: EndedTask | undefined;
    try {
      ended = await withTxRetry(
        {
          db: this.deps.db,
          logger,
          operation: 'step.failInvalid',
          taskId: step.taskId,
        },
        async () => {
          const task = await this.deps.tasks.hold({
            taskId: step.taskId,
            from: [running],
            attempt: step.attempt,
          });
          if (!task) return undefined;
          // As a failed step: its messages go with the failure, so a `revive` among them does not
          // requeue the task into the same invalid result again.
          await this.deps.inbox.markDelivered(task, step.messageIds);
          return endTask(this.deps, task, {
            status: failed,
            failure,
            fields: { recoveries: 0 },
            fence: true,
            cause: 'invalid_result',
          });
        },
      );
    } catch (failError) {
      logger.error(
        'failing an invalid step result failed; left to the recovery sweeper',
        {
          reason: failure.reason,
          durationMs,
          error: failError,
          cause: error,
        },
      );
      return { outcome: 'abandoned', stopped: [] };
    }
    if (!ended) {
      logger.warn(
        'invalid step result rejected: the attempt is no longer current',
        {
          durationMs,
          error,
        },
      );
      return { outcome: 'rejected', stopped: [] };
    }
    logger.error('step result invalid: task failed', {
      reason: failure.reason,
      durationMs,
      error,
      ...(ended.stopped.length > 0 && {
        stoppedIds: ended.stopped.map((task) => task.taskId),
      }),
    });
    logTaskEnds(logger, ended.ends);
    return { outcome: 'invalid', stopped: ended.stopped };
  }
}
