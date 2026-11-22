import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  RuntimeEventTypeSchema,
  type TaskStatus,
  TaskStatusSchema,
  type WaitReason,
  WaitReasonSchema,
} from '@agent-os/contracts';
import {
  Db,
  RuntimeDecisionsRepository,
  RuntimeTrackersRepository,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { RuntimeError } from '../errors';
import { EventLog } from '../events/event-log';
import {
  isFinished,
  type TaskChange,
  type TaskFailure,
  type TaskRow,
} from './guarded-transition';
import { HandlerRegistry } from '../steps/handler.registry';
import { LiveTasks } from '../steps/live-tasks';
import type {
  EnqueueMessage,
  StepSignalReason,
} from '../steps/step-contract';
import { Inbox, payloadTooLarge, reservedKindProblem } from '../messaging/inbox';
import { RunningTaskRegistry } from './running-task.registry';
import type { RuntimeConfig } from '../runtime-config';
import { RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { endTask, writeLocked } from './task-end';
import { Tasks } from './tasks';

const { queued, running, waiting, stopped } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/**
 * What `tasks.interrupt` answers; `not_active` for a finished task or one waiting for a decision or
 * for its tasks.
 */
export type InterruptOutcome = 'interrupted' | 'not_active';

/**
 * The message an interrupt puts in the task's own queue, by the rules of `inbox.enqueue`: by it the
 * next step tells an interrupt from a lost step (`resumedAfterLoss` is true in both).
 */
export type InterruptMessage = Omit<EnqueueMessage, 'recipientId'>;

/** A task as the runtime's operations return it (design-runtime.md, Task). */
export interface Task {
  readonly taskId: string;
  readonly type: string;
  readonly ownerId: string;
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
  ownerId: string;
  input: unknown;
  /** Creates a child of this task, outside a step; the parent must be the owner's and not finished. */
  parentId?: string;
  /** The id of the new task, a UUID; generated when absent. A taken id is `TASK_EXISTS`. */
  taskId?: string;
}

interface TaskControlDeps {
  db: Db;
  handlers: HandlerRegistry;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  trackers: RuntimeTrackersRepository;
  events: EventLog;
  inbox: Inbox;
  decisions: RuntimeDecisionsRepository;
  /** Steps of this process: a command cuts its own process's step off at once (KD-4). */
  running: RunningTaskRegistry;
  /** Objects of the tasks of live types: a cut-off task's object is let go. */
  live: LiveTasks;
  logger: Logger;
  /** `INBOX_PAYLOAD_MAX_BYTES`: bound of an interrupt message's payload. */
  inboxPayloadMaxBytes: number;
}

/**
 * A task an interrupt can reach: `queued`, `running`, or `waiting` for messages or after an
 * interrupt. One waiting for a decision or for its tasks (deep-agents/design-task.md, KD-3) is
 * woken only by them.
 */
const isInterruptible = (task: TaskRow): boolean =>
  task.status === queued ||
  task.status === running ||
  (task.status === waiting &&
    task.waitReason !== WaitReasonSchema.enum.decision &&
    task.waitReason !== WaitReasonSchema.enum.tasks);

function toTask(row: TaskRow): Task {
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
 * raises the attempt, so the step in flight is fenced; the step is then cut off — here at once,
 * elsewhere by NOTIFY or heartbeat.
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
    @Inject(RuntimeTrackersRepository) trackers: RuntimeTrackersRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(Inbox) inbox: Inbox,
    @Inject(RuntimeDecisionsRepository) decisions: RuntimeDecisionsRepository,
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
      trackers,
      events,
      inbox,
      decisions,
      running,
      live,
      logger,
      inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    };
  }

  /**
   * Creates a root task (its own root, depth 0) or, with `parentId`, a child of the owner's task
   * outside a step (same owner and root, one level deeper) in `queued`, with `task.created`. The id
   * is `taskId` when given — `TASK_EXISTS` if a task of any owner has it — or a new one.
   * The parent must not be finished. Returns the `taskId`.
   *
   * Inside a caller's transaction the caller commits or rolls back the whole of it, the task with
   * it (KD-3, self-learning). The `task.created` NOTIFY goes out at that commit; the dispatcher's
   * poll is the guarantee anyway.
   */
  async create(request: CreateTask): Promise<string> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = {
      type: request.type,
      ownerId: request.ownerId,
      parentId: request.parentId ?? null,
    };
    try {
      const input = this.checkInput(request.type, request.input);
      const task = await db.transaction(() => this.createIn(request, input));
      logger.info('task created', {
        ...fields,
        taskId: task.taskId,
        rootId: task.rootId,
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
    if (!row) throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    return toTask(row);
  }

  /** Every task of the owner's tree in creation order; `[]` for another owner's or no tree. */
  async listTree(rootId: string, ownerId: string): Promise<Task[]> {
    const rows = await this.deps.taskRows.listTree(rootId, ownerId);
    return rows.map(toTask);
  }

  /**
   * Interrupts a `queued`, `running` or `waiting` (not for a decision or tasks) task: without a
   * message it becomes `waiting` (`interrupted`), with one the message goes into its queue and it
   * becomes `queued`; `attempt + 1`, the lease cleared, `task.interrupted`. A finished task or one
   * waiting for a decision or its tasks gives `not_active` and changes nothing. `TASK_NOT_FOUND` for a missing or another
   * owner's task, `PAYLOAD_TOO_LARGE` for a message over `INBOX_PAYLOAD_MAX_BYTES`.
   */
  async interrupt(
    taskId: string,
    ownerId: string,
    message?: InterruptMessage,
  ): Promise<InterruptOutcome> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = {
      taskId,
      ownerId,
      withMessage: message !== undefined,
      kind: message?.kind,
      sender: message?.sender,
    };
    try {
      if (message) this.checkMessage(message);
      const interrupted = await db.transaction(() => this.interruptIn(taskId, ownerId, message));
      if (!interrupted) {
        logger.info('task not interrupted: not active', {
          ...fields,
          outcome: 'not_active',
          durationMs: Date.now() - startedAt,
        });
        return 'not_active';
      }
      this.cutOff([interrupted.task], 'interrupted');
      logger.info('task interrupted', {
        ...fields,
        rootId: interrupted.task.rootId,
        status: interrupted.task.status,
        attempt: interrupted.task.attempt,
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
   * Stops the task and every unfinished descendant: `stopped`, `attempt + 1`, `task.stopped`, open
   * requests `cancelled`, one `child_finished` (`stopped`) to the parent of each. Returns the
   * stopped `taskId`s, the task first; `[]` for a finished task, nothing changed. `TASK_NOT_FOUND`
   * for a missing, another owner's or a deleted task.
   */
  async stop(taskId: string, ownerId: string): Promise<string[]> {
    const { db, taskRows, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { taskId, ownerId };
    try {
      const stoppedTasks = await db.transaction(async () => {
        // `find` does not read the deletion mark, so it is checked here, as in `findOwned`.
        const target = await taskRows.find(taskId);
        if (target?.ownerId !== ownerId || target.deletedAt !== null) {
          throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
        }
        if (isFinished(target.status)) return [];
        return this.stopTree(target);
      });
      this.cutOff(stoppedTasks, 'stopped');
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
      logger.warn('task stop failed', { ...fields, durationMs: Date.now() - startedAt, error });
      throw error;
    }
  }

  /**
   * Stops the tree as {@link stop} does and marks every task of it deleted: from then on each
   * answers as a missing one. The rows, their messages, requests and events and the token ledger
   * stay (KD-5); a conversation is deleted by `agents.sessions.deleteRoot`, which also marks its
   * root session. Only a root can be deleted: another task, a missing, another owner's or an
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
      const stoppedTasks = await db.transaction(() => this.deleteTreeIn(rootId, ownerId));
      this.cutOff(stoppedTasks, 'stopped');
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

  /** The deletion's writes: the tree stopped and marked deleted. */
  private async deleteTreeIn(rootId: string, ownerId: string): Promise<TaskRow[]> {
    const { taskRows } = this.deps;
    const root = await taskRows.findOwned(rootId, ownerId);
    if (!root || root.parentId !== null) {
      throw new RuntimeError('TASK_NOT_FOUND', `Task ${rootId} not found`);
    }
    const stoppedInTree = await this.stopTree(root);
    await taskRows.markDeleted(root.taskId);
    return stoppedInTree;
  }

  /** The creation's writes: the task row and `task.created`. */
  private async createIn(request: CreateTask, input: unknown): Promise<TaskRow> {
    const { tasks, taskRows, events } = this.deps;
    const taskId: string = request.taskId ?? randomUUID();
    let lineage: { parentId: string | null; rootId: string; depth: number } = {
      parentId: null,
      rootId: taskId,
      depth: 0,
    };
    if (request.parentId !== undefined) {
      const parent = await taskRows.findOwned(request.parentId, request.ownerId);
      if (!parent) {
        throw new RuntimeError('TASK_NOT_FOUND', `Task ${request.parentId} not found`);
      }
      if (isFinished(parent.status)) {
        throw new RuntimeError(
          'PARENT_FINISHED',
          `Parent task ${parent.taskId} is ${parent.status}`,
        );
      }
      lineage = { parentId: parent.taskId, rootId: parent.rootId, depth: parent.depth + 1 };
    }
    const row = await tasks.insert({
      taskId,
      type: request.type,
      ownerId: request.ownerId,
      input,
      ...lineage,
    });
    await events.append({
      type: RuntimeEventTypeSchema.enum['task.created'],
      task: row,
      payload: { type: row.type, parentId: row.parentId, depth: row.depth },
    });
    return row;
  }

  /** The interrupt's writes; `undefined` when the task is not active. */
  private async interruptIn(
    taskId: string,
    ownerId: string,
    message: InterruptMessage | undefined,
  ): Promise<{ task: TaskRow; messageId: string | undefined } | undefined> {
    const { tasks, taskRows, events, inbox } = this.deps;
    const task = await taskRows.findOwned(taskId, ownerId);
    if (!task) throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    if (!isInterruptible(task)) return undefined;

    const change: TaskChange = message
      ? { kind: 'set', status: queued, fence: true }
      : { kind: 'wait', reason: WaitReasonSchema.enum.interrupted, fence: true };
    const row = await writeLocked(tasks, task, change);
    await events.append({
      type: EVENT['task.interrupted'],
      task: row,
      payload: { from: task.status, status: row.status, withMessage: message !== undefined },
    });
    if (!message) return { task: row, messageId: undefined };
    // The task is `queued` already: the message wakes nothing.
    const inserted = await inbox.insertMessage({
      recipientId: taskId,
      ownerId,
      kind: message.kind,
      sender: message.sender,
      payload: message.payload,
      revive: message.revive ?? false,
    });
    return { task: inserted.recipient, messageId: inserted.messageId };
  }

  /**
   * Stops `top` (unless finished) and every unfinished descendant. Descendants are read level by
   * level; a parent stopped here has its attempt raised, so its commit that would spawn a child
   * afterwards is fenced. Tasks end top-down: only a task's children, ending later, write to it.
   */
  private async stopTree(top: TaskRow): Promise<TaskRow[]> {
    const tree = [top, ...(await this.listDescendants(top.taskId))];
    const stoppedTasks: TaskRow[] = [];
    for (const task of tree) {
      if (isFinished(task.status)) continue;
      stoppedTasks.push(
        await endTask(this.deps, task, {
          status: stopped,
          fields: { stepClaims: 0, recoveries: 0 },
          fence: true,
        }),
      );
    }
    if (stoppedTasks.length > 0) {
      // Invariant 3: a task that no longer waits has no open request.
      await this.deps.decisions.cancelOpen(stoppedTasks.map((task) => task.taskId));
    }
    return stoppedTasks;
  }

  /** Every descendant of the task, read level by level, in that order. */
  private async listDescendants(taskId: string): Promise<TaskRow[]> {
    const descendants: TaskRow[] = [];
    let parentIds = [taskId];
    while (parentIds.length > 0) {
      const level = await this.listLevel(parentIds);
      descendants.push(...level);
      parentIds = level.map((task) => task.taskId);
    }
    return descendants;
  }

  /** The children of `parentIds`, re-read until no new one shows up, by `task_id`. */
  private async listLevel(parentIds: readonly string[]): Promise<TaskRow[]> {
    const children = new Map<string, TaskRow>();
    for (;;) {
      const rows = await this.deps.taskRows.listChildren(parentIds);
      const known = children.size;
      for (const row of rows) children.set(row.taskId, row);
      if (children.size === known) break;
    }
    return [...children.values()].sort((left, right) =>
      left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
    );
  }

  /**
   * Cuts off this process's steps of the tasks whose attempt the command raised, and lets their
   * live objects go: a cut-off step may have written what its object has not taken in.
   */
  private cutOff(changed: readonly TaskRow[], reason: StepSignalReason): void {
    for (const task of changed) {
      // Not awaited: the steps end when their handlers answer the signal.
      void this.deps.running.abortTask(task.taskId, reason, task.attempt);
    }
    this.deps.live.evict(changed.map((task) => task.taskId));
  }

  /** The rules of `inbox.enqueue` for an interrupt's message. */
  private checkMessage(message: InterruptMessage): void {
    const reserved = reservedKindProblem(message.kind);
    if (reserved !== undefined) throw new Error(reserved);
    const tooLarge = payloadTooLarge(message.payload, this.deps.inboxPayloadMaxBytes);
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
