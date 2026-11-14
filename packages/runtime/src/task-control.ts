import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  CHILD_FINISHED_KIND,
  DecisionStatusSchema,
  RuntimeEventTypeSchema,
  type TaskStatus,
  TaskStatusSchema,
  type WaitReason,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type Database, runtimeDecisions, runtimeTasks } from '@agent-os/db';
import { and, eq, inArray } from 'drizzle-orm';
import { RuntimeError } from './errors.js';
import type { EventLog } from './event-log.js';
import { isFinished, type TaskChange, type TaskRow } from './guarded-transition.js';
import type {
  EnqueueMessage,
  HandlerRegistry,
  StepSignalReason,
} from './handler.registry.js';
import { type Inbox, payloadTooLarge } from './inbox.js';
import type { RunningTaskRegistry } from './running-task.registry.js';
import { retryingTransaction, type RuntimeTx } from './runtime-tx.js';
import { endTask, type TaskFailure, writeLocked } from './step-commit.js';
import type { TaskRepository } from './task.repository.js';

const { queued, running, waiting, stopped } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/** What `tasks.interrupt` answers; `not_active` for a finished task or one awaiting a decision. */
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
}

/** What `tasks.create` takes. */
export interface CreateTask {
  type: string;
  ownerId: string;
  input: unknown;
  /** Creates a child of this task, outside a step; the parent must be the owner's and not finished. */
  parentId?: string;
}

export interface TaskControlDeps {
  db: Database;
  handlers: HandlerRegistry;
  tasks: TaskRepository;
  events: EventLog;
  inbox: Inbox;
  /** Steps of this process: a command cuts its own process's step off at once (KD-4). */
  running: RunningTaskRegistry;
  logger: Logger;
  /** `INBOX_PAYLOAD_MAX_BYTES`: bound of an interrupt message's payload. */
  inboxPayloadMaxBytes: number;
}

/** A task an interrupt can reach: `queued`, `running`, or `waiting` for anything but a decision. */
const isInterruptible = (task: TaskRow): boolean =>
  task.status === queued ||
  task.status === running ||
  (task.status === waiting && task.waitReason !== WaitReasonSchema.enum.decision);

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
  };
}

/**
 * Creation, reading and the commands of tasks (design-runtime.md, Задачи; KD-4, Flow 4). Another
 * owner's task answers as a missing one: `TASK_NOT_FOUND` for a single task, `[]` for a list (plan
 * Notes 1). A command changes the status in its own transaction and raises the attempt, so the step
 * in flight is fenced; the step is then cut off — here at once, elsewhere by NOTIFY or heartbeat.
 *
 * Lock order (plan Notes 4, Invariant 6): an ancestor before its descendants, one level by
 * `task_id`. A write that may end a task locks its parent first (the end notice goes there);
 * `create` locks the parent; a step's commit holds its own task, the parent of what it spawns.
 */
export class TaskControl {
  constructor(private readonly deps: TaskControlDeps) {}

  /**
   * Creates a root task (its own root, depth 0) or, with `parentId`, a child of the owner's task
   * outside a step (same owner and root, one level deeper) in `queued`, with `task.created`.
   * The parent is locked FOR UPDATE and must not be finished: a stop of the parent and this
   * creation are ordered by that lock (plan Notes 4, Invariant 6). Returns the `taskId`.
   */
  async create(request: CreateTask): Promise<string> {
    const { db, tasks, events, logger } = this.deps;
    const startedAt = Date.now();
    const fields = {
      type: request.type,
      ownerId: request.ownerId,
      parentId: request.parentId ?? null,
    };
    try {
      const input = this.checkInput(request.type, request.input);
      const task = await retryingTransaction(db, logger, 'tasks.create', async (tx) => {
        const taskId: string = randomUUID();
        let lineage: { parentId: string | null; rootId: string; depth: number } = {
          parentId: null,
          rootId: taskId,
          depth: 0,
        };
        if (request.parentId !== undefined) {
          const parent = await tasks.lockOwned(tx, request.parentId, request.ownerId);
          if (!parent) {
            throw new RuntimeError('TASK_NOT_FOUND', `Task ${request.parentId} not found`);
          }
          if (isFinished(parent.status)) {
            throw new RuntimeError(
              'PARENT_FINISHED',
              `Parent task ${parent.taskId} is ${parent.status}`,
            );
          }
          lineage = {
            parentId: parent.taskId,
            rootId: parent.rootId,
            depth: parent.depth + 1,
          };
        }
        const row = await tasks.insert(tx, {
          taskId,
          type: request.type,
          ownerId: request.ownerId,
          input,
          ...lineage,
        });
        await events.append(tx, {
          type: RuntimeEventTypeSchema.enum['task.created'],
          task: row,
          payload: { type: row.type, parentId: row.parentId, depth: row.depth },
        });
        return row;
      });
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
    const row = await this.deps.db.transaction((tx) =>
      this.deps.tasks.findOwned(tx, taskId, ownerId),
    );
    if (!row) throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    return toTask(row);
  }

  /** Every task of the owner's tree in creation order; `[]` for another owner's or no tree. */
  async listTree(rootId: string, ownerId: string): Promise<Task[]> {
    const rows = await this.deps.db.transaction((tx) =>
      this.deps.tasks.listTree(tx, rootId, ownerId),
    );
    return rows.map(toTask);
  }

  /**
   * Interrupts a `queued`, `running` or `waiting` (not for a decision) task: without a message it
   * becomes `waiting` (`interrupted`), with one the message goes into its queue and it becomes
   * `queued`; `attempt + 1`, the lease cleared, `task.interrupted`. A finished task or one waiting
   * for a decision gives `not_active` and changes nothing. `TASK_NOT_FOUND` for a missing or another
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
      const interrupted = await retryingTransaction(db, logger, 'tasks.interrupt', (tx) =>
        this.interruptIn(tx, taskId, ownerId, message),
      );
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
   * for a missing or another owner's task.
   */
  async stop(taskId: string, ownerId: string): Promise<string[]> {
    const { db, tasks, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { taskId, ownerId };
    try {
      const stoppedTasks = await retryingTransaction(db, logger, 'tasks.stop', async (tx) => {
        // The target's end notice goes to its parent: the parent is locked first.
        const target = await tasks.lockWithParent(tx, taskId);
        if (target?.ownerId !== ownerId) {
          throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
        }
        if (isFinished(target.status)) return [];
        return this.stopTree(tx, target);
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
   * Stops the tree as {@link stop} does, then deletes its root; the cascade removes the tree's
   * tasks, messages, requests and events, while the token ledger keeps its rows (KD-5). Only a root
   * can be deleted: another task, a missing or another owner's one gives `TASK_NOT_FOUND`.
   */
  async deleteTree(rootId: string, ownerId: string): Promise<'deleted'> {
    const { db, tasks, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { rootId, ownerId };
    try {
      const stoppedTasks = await retryingTransaction(db, logger, 'tasks.deleteTree', async (tx) => {
        const root = await tasks.lockOwned(tx, rootId, ownerId);
        if (!root || root.parentId !== null) {
          throw new RuntimeError('TASK_NOT_FOUND', `Task ${rootId} not found`);
        }
        const stoppedInTree = await this.stopTree(tx, root);
        await tx.delete(runtimeTasks).where(eq(runtimeTasks.taskId, root.taskId));
        return stoppedInTree;
      });
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

  /** The interrupt under the task's lock; `undefined` when the task is not active. */
  private async interruptIn(
    tx: RuntimeTx,
    taskId: string,
    ownerId: string,
    message: InterruptMessage | undefined,
  ): Promise<{ task: TaskRow; messageId: string | undefined } | undefined> {
    const { tasks, events, inbox } = this.deps;
    const task = await tasks.lockOwned(tx, taskId, ownerId);
    if (!task) throw new RuntimeError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    if (!isInterruptible(task)) return undefined;

    const change: TaskChange = message
      ? { kind: 'set', status: queued, fence: true }
      : { kind: 'wait', reason: WaitReasonSchema.enum.interrupted, fence: true };
    const row = await writeLocked(tx, tasks, task, change);
    await events.append(tx, {
      type: EVENT['task.interrupted'],
      task: row,
      payload: { from: task.status, status: row.status, withMessage: message !== undefined },
    });
    if (!message) return { task: row, messageId: undefined };
    // The task is `queued` already: the message wakes nothing.
    const inserted = await inbox.insertMessage(tx, {
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
   * Stops `top` (unless finished) and every unfinished descendant, the caller holding `top`'s lock
   * and its parent's. Descendants are locked level by level, each level re-read after its locks
   * until no new child shows up: a child spawned meanwhile either committed before the lock and is
   * stopped here, or its parent's commit is fenced (Invariant 6). Tasks end top-down, so each row
   * is still as locked when it ends: only its children, ending later, write to it.
   */
  private async stopTree(tx: RuntimeTx, top: TaskRow): Promise<TaskRow[]> {
    const { tasks, events, inbox } = this.deps;
    const tree = [top, ...(await this.lockDescendants(tx, top.taskId))];
    const stoppedTasks: TaskRow[] = [];
    for (const task of tree) {
      if (isFinished(task.status)) continue;
      stoppedTasks.push(
        await endTask(tx, { tasks, events, inbox }, task, {
          status: stopped,
          fields: { stepClaims: 0, recoveries: 0 },
          fence: true,
        }),
      );
    }
    if (stoppedTasks.length > 0) {
      // Invariant 3: a task that no longer waits has no open request. The task is locked before
      // its request, as in `Decisions.resolve`.
      await tx
        .update(runtimeDecisions)
        .set({ status: DecisionStatusSchema.enum.cancelled })
        .where(
          and(
            inArray(
              runtimeDecisions.taskId,
              stoppedTasks.map((task) => task.taskId),
            ),
            eq(runtimeDecisions.status, DecisionStatusSchema.enum.open),
          ),
        );
    }
    return stoppedTasks;
  }

  /** Every descendant of the task, locked FOR UPDATE level by level, in that order. */
  private async lockDescendants(tx: RuntimeTx, taskId: string): Promise<TaskRow[]> {
    const descendants: TaskRow[] = [];
    let parentIds = [taskId];
    while (parentIds.length > 0) {
      const level = await this.lockLevel(tx, parentIds);
      descendants.push(...level);
      parentIds = level.map((task) => task.taskId);
    }
    return descendants;
  }

  /** The children of `parentIds`, locked and re-read until no new one shows up, by `task_id`. */
  private async lockLevel(tx: RuntimeTx, parentIds: readonly string[]): Promise<TaskRow[]> {
    const children = new Map<string, TaskRow>();
    for (;;) {
      const rows = await this.deps.tasks.lockChildren(tx, parentIds);
      const known = children.size;
      for (const row of rows) children.set(row.taskId, row);
      if (children.size === known) break;
    }
    return [...children.values()].sort((left, right) =>
      left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
    );
  }

  /** Cuts off this process's steps of the tasks whose attempt the command raised. */
  private cutOff(changed: readonly TaskRow[], reason: StepSignalReason): void {
    for (const task of changed) {
      // Not awaited: the steps end when their handlers answer the signal.
      void this.deps.running.abortTask(task.taskId, reason, task.attempt);
    }
  }

  /** The rules of `inbox.enqueue` for an interrupt's message. */
  private checkMessage(message: InterruptMessage): void {
    if (message.kind === CHILD_FINISHED_KIND) {
      throw new Error(`message kind "${CHILD_FINISHED_KIND}" is reserved by the runtime`);
    }
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
