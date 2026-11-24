import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  type TaskStatus,
  TaskStatusSchema,
  type WaitReason,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { Db, RuntimeTasksRepository, type RuntimeTaskRow } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { RuntimeError } from '../errors';
import {
  isFinished,
  type TaskFailure,
  UNFINISHED_STATUSES,
} from './guarded-transition';
import { HandlerRegistry } from '../steps/handler.registry';
import { LiveTasks } from '../steps/live-tasks';
import {
  type EnqueueMessage,
  QUESTION_TASK_TYPE,
} from '../steps/step-contract';
import {
  Inbox,
  payloadTooLarge,
  reservedKindProblem,
} from '../messaging/inbox';
import { RunningTaskRegistry } from './running-task.registry';
import type { RuntimeConfig } from '../runtime-config';
import { RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import {
  cutOff,
  endTask,
  logTaskEnds,
  type StoppedTree,
  stopTree,
  type TaskEndDeps,
  type TaskEndRecord,
  taskLogFields,
  writeHeld,
} from './task-end';
import { TaskEndHooks } from './task-end-hooks';
import { Tasks } from './tasks';
import { withTxRetry } from './transaction-retry';

const { queued, running, waiting } = TaskStatusSchema.enum;

/**
 * What `tasks.interrupt` answers; `not_active` for a finished task or one waiting for its children
 * or for a human's answer.
 */
export type InterruptOutcome = 'interrupted' | 'not_active';

/**
 * What `tasks.answer` answers: `answered` — the question completed with the answer; or
 * `already_answered` — it was answered or stopped before, nothing written.
 */
export type AnswerOutcome = 'answered' | 'already_answered';

/**
 * The message an interrupt puts in the task's own queue, by the rules of `inbox.enqueue`; every
 * interrupt carries one (design-runtime.md, «Состояния задачи», Прерывание).
 */
export type InterruptMessage = Omit<EnqueueMessage, 'recipientId'>;

/** A task as the runtime's operations return it (design-runtime.md, Task). */
export interface Task {
  readonly taskId: string;
  readonly type: string;
  /** `null` for the platform's own work, which no employee sees. */
  readonly ownerId: string | null;
  /** `null` for a root task. */
  readonly parentId: string | null;
  readonly rootId: string;
  /** 0 for a root task. */
  readonly depth: number;
  readonly status: TaskStatus;
  /** Set exactly while the task is `waiting`. */
  readonly waitReason: WaitReason | null;
  /** Committed steps of the task. */
  readonly stepNo: number;
  /** The outcome of a `completed` task. */
  readonly result: unknown;
  /** The reason of a `failed` task. */
  readonly failure: TaskFailure | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
  /** The input the task was created with, as its handler parsed it. */
  readonly input: unknown;
}

/** What `tasks.create` takes. */
export interface CreateTask {
  type: string;
  /** `null` for the platform's own work without an owner. */
  ownerId: string | null;
  input: unknown;
  /** Creates a child of this task, outside a step; the parent must be the owner's and not finished. */
  parentId?: string;
  /** The id of the new task, a UUID; generated when absent. A taken id is `TASK_EXISTS`. */
  taskId?: string;
  /** An opaque string of the creator: while an unfinished task of `type` holds it, `create` answers `null`. */
  exclusiveKey?: string;
}

interface TaskControlDeps extends TaskEndDeps {
  handlers: HandlerRegistry;
  /** Steps of this process: a command cuts its own process's step off at once (KD-4). */
  running: RunningTaskRegistry;
  /** Objects of the tasks of live types: a cut-off task's object is let go. */
  live: LiveTasks;
  /** `INBOX_PAYLOAD_MAX_BYTES`: bound of an interrupt message's payload and of an answer. */
  inboxPayloadMaxBytes: number;
}

/**
 * A task an interrupt can reach: `queued`, `running`, or `waiting` for messages. One waiting for its
 * children (KD-2) or a question waiting for its answer (KD-3) is woken only by them.
 */
const isInterruptible = (task: RuntimeTaskRow): boolean =>
  task.status === queued ||
  task.status === running ||
  (task.status === waiting &&
    task.waitReason === WaitReasonSchema.enum.messages);

function toTask(row: RuntimeTaskRow): Task {
  return {
    taskId: row.taskId,
    type: row.type,
    ownerId: row.ownerId,
    parentId: row.parentId,
    rootId: row.rootId,
    depth: row.depth,
    status: TaskStatusSchema.parse(row.status),
    waitReason:
      row.waitReason === null ? null : WaitReasonSchema.parse(row.waitReason),
    stepNo: row.stepNo,
    result: row.result,
    failure: row.failure as TaskFailure | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    input: row.input,
  };
}

/**
 * Creation, reading and the commands of tasks (design-runtime.md, Задачи; KD-4, Flow 4). Another
 * owner's task and a task of a deleted tree answer as a missing one: `TASK_NOT_FOUND` for a single
 * task, `[]` for a list (plan Notes 1). A command changes the status in its own transaction and
 * raises the attempt, so the step in flight is fenced; the step is then cut off at once.
 *
 * Each command is one transaction; called inside a caller's `db.transaction` it joins that one.
 */
@Injectable()
export class TaskControl {
  private readonly deps: TaskControlDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(HandlerRegistry) handlers: HandlerRegistry,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(Inbox) inbox: Inbox,
    @Inject(TaskEndHooks) endHooks: TaskEndHooks,
    @Inject(RunningTaskRegistry) running: RunningTaskRegistry,
    @Inject(LiveTasks) live: LiveTasks,
    @Inject(RUNTIME_LOGGER) logger: Logger,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
  ) {
    this.deps = {
      db,
      handlers,
      tasks,
      taskRows,
      inbox,
      endHooks,
      running,
      live,
      logger,
      inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    };
  }

  /**
   * Creates a root task (its own root, depth 0) or, with `parentId`, a child of the owner's task
   * outside a step (same owner and root, one level deeper) in `queued`, signalling its tree. The id
   * is `taskId` when given — `TASK_EXISTS` if a task of any owner has it — or a new one.
   * The parent must not be finished. Returns the `taskId`.
   *
   * Inside a caller's transaction the caller commits or rolls back the whole of it, the task with
   * it (KD-3, self-learning). The tree's NOTIFY goes out at that commit; the dispatcher's
   * poll is the guarantee anyway.
   *
   * With `exclusiveKey`: `null` when an unfinished task of the type holds the key. Only the partial
   * unique index decides it, so of two concurrent creates exactly one wins; the insert raises no
   * error, and the caller's transaction goes on with nothing written by this creation.
   */
  create(request: CreateTask & { exclusiveKey?: undefined }): Promise<string>;
  create(request: CreateTask): Promise<string | null>;
  async create(request: CreateTask): Promise<string | null> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = {
      type: request.type,
      ownerId: request.ownerId,
      parentId: request.parentId ?? null,
      exclusiveKey: request.exclusiveKey ?? null,
    };
    try {
      const input = this.checkInput(request.type, request.input);
      const task = await withTxRetry(
        { db, logger, operation: 'tasks.create', taskId: request.taskId },
        () => this.createIn(request, input),
      );
      if (task === null) {
        logger.info('task not created: key taken', {
          ...fields,
          durationMs: Date.now() - startedAt,
        });
        return null;
      }
      logger.info('task created', {
        ...fields,
        ...taskLogFields(task),
        depth: task.depth,
        durationMs: Date.now() - startedAt,
      });
      return task.taskId;
    } catch (error) {
      logger.warn('task not created', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /** The owner's task; `TASK_NOT_FOUND` for a missing or another owner's one. */
  async get(taskId: string, ownerId: string): Promise<Task> {
    const row = await this.deps.taskRows.findOwned(taskId, ownerId);
    if (!row)
      throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    return toTask(row);
  }

  /** Every task of the owner's tree in creation order; `[]` for another owner's or no tree. */
  async listTree(rootId: string, ownerId: string): Promise<Task[]> {
    const rows = await this.deps.taskRows.listTree(rootId, ownerId);
    return rows.map(toTask);
  }

  /**
   * Interrupts a `queued`, `running` or `waiting(messages)` task: it becomes `queued` with
   * `attempt + 1` and `recoveries = 0`, and the message goes into its queue. A finished task or one
   * waiting for its children or a human gives `not_active` and changes nothing. `TASK_NOT_FOUND` for a missing or
   * another owner's task, `PAYLOAD_TOO_LARGE` for a message over `INBOX_PAYLOAD_MAX_BYTES`.
   */
  async interrupt(
    taskId: string,
    ownerId: string,
    message: InterruptMessage,
  ): Promise<InterruptOutcome> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = {
      taskId,
      ownerId,
      kind: message.kind,
    };
    try {
      this.checkMessage(message);
      const interrupted = await withTxRetry(
        { db, logger, operation: 'tasks.interrupt', taskId },
        () => this.interruptIn(taskId, ownerId, message),
      );
      if (!interrupted) {
        logger.info('task not interrupted: not active', {
          ...fields,
          outcome: 'not_active',
          durationMs: Date.now() - startedAt,
        });
        return 'not_active';
      }
      cutOff(this.deps, [interrupted.task], 'interrupted');
      logger.info('task interrupted', {
        ...fields,
        ...taskLogFields(interrupted.task),
        from: interrupted.from,
        to: interrupted.task.status,
        messageId: interrupted.messageId,
        outcome: 'interrupted',
        durationMs: Date.now() - startedAt,
      });
      return 'interrupted';
    } catch (error) {
      logger.warn('task interrupt failed', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * The human's answer to a question (KD-3) in its own transaction: `answered` — the question is
   * `completed` with `answer` as its `result`, and its `child_finished` wakes the asking task by the
   * wake-up rule (KD-2); `already_answered` — answered or stopped before, nothing written.
   * `TASK_NOT_FOUND` for a missing question, another owner's, one of a deleted tree or a task that
   * is no question; `PAYLOAD_TOO_LARGE` for an answer over `INBOX_PAYLOAD_MAX_BYTES`, as it travels
   * in `child_finished`.
   */
  async answer(
    questionId: string,
    ownerId: string,
    answer: unknown,
  ): Promise<AnswerOutcome> {
    const { db, logger, inboxPayloadMaxBytes } = this.deps;
    const startedAt = Date.now();
    const fields = { questionId, ownerId };
    try {
      const tooLarge = payloadTooLarge(answer ?? null, inboxPayloadMaxBytes);
      if (tooLarge) throw tooLarge;
      const answered = await withTxRetry(
        { db, logger, operation: 'tasks.answer', taskId: questionId },
        () => this.answerIn(questionId, ownerId, answer ?? null),
      );
      const [end] = answered.ends;
      if (answered.ends.length > 0) logTaskEnds(logger, answered.ends);
      logger.info('question answered', {
        ...fields,
        ...taskLogFields(answered.question),
        askerId: answered.question.parentId,
        outcome: answered.outcome,
        askerWoken: end?.parentWoken ?? false,
        durationMs: Date.now() - startedAt,
      });
      return answered.outcome;
    } catch (error) {
      logger.warn('question not answered', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * Stops the task and every unfinished descendant: `stopped`, `attempt + 1`, its
   * questions with it, one `child_finished` (`stopped`) to the parent of each. Returns the
   * stopped `taskId`s, the task first; `[]` for a finished task, nothing changed. `TASK_NOT_FOUND`
   * for a missing, another owner's or a deleted task.
   */
  async stop(taskId: string, ownerId: string): Promise<string[]> {
    const { db, taskRows, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { taskId, ownerId };
    try {
      const { stopped: stoppedTasks, ends } = await withTxRetry(
        { db, logger, operation: 'tasks.stop', taskId },
        async (): Promise<StoppedTree> => {
          // `find` does not read the deletion mark, so it is checked here, as in `findOwned`.
          const target = await taskRows.find(taskId);
          if (target?.ownerId !== ownerId || target.deletedAt !== null) {
            throw new RuntimeError(
              'TASK_NOT_FOUND',
              `Task ${taskId} not found`,
            );
          }
          if (isFinished(target.status)) return { stopped: [], ends: [] };
          return stopTree(this.deps, target);
        },
      );
      cutOff(this.deps, stoppedTasks, 'stopped');
      logTaskEnds(logger, ends);
      const stoppedIds = stoppedTasks.map((task) => task.taskId);
      logger.info('task stop answered', {
        ...fields,
        rootId: stoppedTasks[0]?.rootId,
        stoppedIds,
        outcome: stoppedIds.length === 0 ? 'not_active' : 'stopped',
        durationMs: Date.now() - startedAt,
      });
      return stoppedIds;
    } catch (error) {
      logger.warn('task stop failed', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * Stops the tree as {@link stop} does and marks every task of it deleted: from then on each
   * answers as a missing one. The rows, their messages, requests and the token ledger
   * stay (KD-5). This is the only deletion mark: what an upper layer keeps for the tree answers as
   * missing through it (KD-2). Only a root can be deleted: another task, a missing, another owner's or an
   * already deleted one gives `TASK_NOT_FOUND`.
   *
   * This process's steps of the stopped tasks are cut off right after the write, also when the
   * write joined a caller's transaction that has not committed yet: if that one rolls back, the
   * cut-off steps are lost steps, and the sweeper queues their tasks again.
   */
  async deleteTree(rootId: string, ownerId: string): Promise<'deleted'> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { rootId, ownerId };
    try {
      const { stopped: stoppedTasks, ends } = await withTxRetry(
        { db, logger, operation: 'tasks.deleteTree', taskId: rootId },
        () => this.deleteTreeIn(rootId, ownerId),
      );
      cutOff(this.deps, stoppedTasks, 'stopped');
      logTaskEnds(logger, ends);
      logger.info('task tree deleted', {
        ...fields,
        stoppedIds: stoppedTasks.map((task) => task.taskId),
        outcome: 'deleted',
        durationMs: Date.now() - startedAt,
      });
      return 'deleted';
    } catch (error) {
      logger.warn('task tree not deleted', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * The answer's writes. The question's row is the first write (KD-7), guarded by `waiting`
   * (`human`): an answer or a stop that came first has ended it, and this one writes nothing. Its
   * end goes through {@link endTask}, so the asker's wake-up follows the wake-up rule.
   */
  private async answerIn(
    questionId: string,
    ownerId: string,
    answer: unknown,
  ): Promise<{
    outcome: AnswerOutcome;
    question: RuntimeTaskRow;
    ends: readonly TaskEndRecord[];
  }> {
    const { tasks, taskRows } = this.deps;
    const notFound = () =>
      new RuntimeError('TASK_NOT_FOUND', `Task ${questionId} not found`);
    const found = await taskRows.findOwned(questionId, ownerId);
    if (found?.type !== QUESTION_TASK_TYPE) throw notFound();
    const held = await tasks.hold({
      taskId: questionId,
      from: [waiting],
      waitReason: WaitReasonSchema.enum.human,
    });
    if (!held) {
      // A deletion that came first stopped the tree and marked it: the question answers as missing,
      // as `already_answered` would tell the deleted tree apart.
      const now = await taskRows.find(questionId);
      if (now?.deletedAt !== null) throw notFound();
      return { outcome: 'already_answered', question: now, ends: [] };
    }
    const ended = await endTask(this.deps, held, {
      status: TaskStatusSchema.enum.completed,
      result: answer,
      cause: 'answer',
    });
    return { outcome: 'answered', question: ended.row, ends: ended.ends };
  }

  /** The deletion's writes: the tree stopped and marked deleted. */
  private async deleteTreeIn(
    rootId: string,
    ownerId: string,
  ): Promise<StoppedTree> {
    const { taskRows } = this.deps;
    const root = await taskRows.findOwned(rootId, ownerId);
    if (!root || root.parentId !== null) {
      throw new RuntimeError('TASK_NOT_FOUND', `Task ${rootId} not found`);
    }
    const stoppedTree = await stopTree(this.deps, root);
    await taskRows.markDeleted(root.taskId);
    return stoppedTree;
  }

  /** The creation's writes: the task row; `null` — the exclusive key is taken. */
  private async createIn(
    request: CreateTask,
    input: unknown,
  ): Promise<RuntimeTaskRow | null> {
    const { tasks, taskRows } = this.deps;
    const taskId: string = request.taskId ?? randomUUID();
    let lineage: { parentId: string | null; rootId: string; depth: number } = {
      parentId: null,
      rootId: taskId,
      depth: 0,
    };
    if (request.parentId !== undefined) {
      const found = await taskRows.findOwned(request.parentId, request.ownerId);
      // A question task has no children: it is ended only by its answer or a stop (KD-3).
      if (!found || found.type === QUESTION_TASK_TYPE) {
        throw new RuntimeError(
          'TASK_NOT_FOUND',
          `Task ${request.parentId} not found`,
        );
      }
      // A write of the parent's row: a stop of the parent comes before it, and the child is
      // refused, or after this creation, and stops the child too.
      const parent = await tasks.hold({
        taskId: found.taskId,
        from: UNFINISHED_STATUSES,
      });
      if (!parent) {
        throw new RuntimeError(
          'PARENT_FINISHED',
          `Parent task ${found.taskId} is finished`,
        );
      }
      lineage = {
        parentId: parent.taskId,
        rootId: parent.rootId,
        depth: parent.depth + 1,
      };
    }
    return tasks.insert({
      taskId,
      type: request.type,
      ownerId: request.ownerId,
      input,
      exclusiveKey: request.exclusiveKey ?? null,
      ...lineage,
    });
  }

  /** The interrupt's writes; `undefined` when the task is not active. */
  private async interruptIn(
    taskId: string,
    ownerId: string,
    message: InterruptMessage,
  ): Promise<
    { task: RuntimeTaskRow; from: string; messageId: string } | undefined
  > {
    const { tasks, taskRows, inbox } = this.deps;
    const found = await taskRows.findOwned(taskId, ownerId);
    if (!found)
      throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    // Checked on the plain read too, so that a task that is not active is not written at all.
    if (!isInterruptible(found)) return undefined;
    const task = await tasks.hold({ taskId, from: UNFINISHED_STATUSES });
    if (!task || !isInterruptible(task)) return undefined;

    await writeHeld(tasks, task, {
      kind: 'set',
      status: queued,
      fields: { recoveries: 0 },
      fence: true,
    });
    const from = task.status;
    // The task is `queued` already: the message wakes nothing.
    const inserted = await inbox.insertMessage({
      recipientId: taskId,
      ownerId,
      kind: message.kind,
      payload: message.payload,
      revive: message.revive ?? false,
    });
    return { task: inserted.recipient, from, messageId: inserted.messageId };
  }

  /** The rules of `inbox.enqueue` for an interrupt's message. */
  private checkMessage(message: InterruptMessage): void {
    const reserved = reservedKindProblem(message.kind);
    if (reserved !== undefined) throw new Error(reserved);
    const tooLarge = payloadTooLarge(
      message.payload,
      this.deps.inboxPayloadMaxBytes,
    );
    if (tooLarge) throw tooLarge;
  }

  /** The handler of `type` checks `input`; returns the parsed input. */
  private checkInput(type: string, input: unknown): unknown {
    const handler = this.deps.handlers.get(type);
    if (!handler) {
      throw new RuntimeError(
        'UNKNOWN_TASK_TYPE',
        `No handler is registered for task type "${type}"`,
      );
    }
    const parsed = handler.inputSchema.safeParse(input);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      throw new RuntimeError(
        'INVALID_TASK_INPUT',
        `Input of task type "${type}" rejected at ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
    }
    return parsed.data;
  }
}
