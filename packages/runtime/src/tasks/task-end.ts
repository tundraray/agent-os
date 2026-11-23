import {
  CHILD_FINISHED_KIND,
  type ChildFinishedPayload,
  TaskEndStatusSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import type { Logger } from '@agent-os/common';
import type { Db, RuntimeTasksRepository, RuntimeTaskRow } from '@agent-os/db';
import type { Inbox, InsertedMessage } from '../messaging/inbox';
import type { LiveTasks } from '../steps/live-tasks';
import type { StepSignalReason } from '../steps/step-contract';
import {
  type TaskChange,
  type TaskFailure,
  type TaskValues,
  UNFINISHED_STATUSES,
} from './guarded-transition';
import type { RunningTaskRegistry } from './running-task.registry';
import type { TaskEndHookInput, TaskEndHooks } from './task-end-hooks';
import type { Tasks } from './tasks';
import { inSavepoint } from './transaction-retry';

const { queued, completed, failed, stopped } = TaskStatusSchema.enum;

/** Services the end of a task writes through. */
export interface TaskEndDeps {
  /** The savepoint of each end hook. */
  db: Db;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  inbox: Inbox;
  endHooks: TaskEndHooks;
  logger: Logger;
}

/**
 * Why a task ended, for its log record: its step (`complete`, `fail`, a handler's exception), a stop
 * of its tree, the answer to a question, the failure of an ancestor, a step lost too many times, an
 * invalid step result or the step time limit.
 */
export type TaskEndCause =
  | 'step'
  | 'stop'
  | 'answer'
  | 'parent_failed'
  | 'recovery'
  | 'invalid_result'
  | 'step_timeout';

/** What one end wrote, collected in the transaction and logged after its commit ({@link logTaskEnds}). */
export interface TaskEndRecord {
  /** The task's row after the end (`queued` again when it revived). */
  readonly row: RuntimeTaskRow;
  readonly from: string;
  readonly status: TaskEnd['status'];
  readonly cause: TaskEndCause;
  readonly failure: TaskFailure | undefined;
  /** The `child_finished` to the parent; none for a root. */
  readonly noticeId: string | undefined;
  readonly parentWoken: boolean;
  readonly revived: boolean;
  /** The descendants this end stopped, top-down. */
  readonly stoppedIds: readonly string[];
}

/** What a stop of a tree wrote: the stopped rows and their ends, top-down. */
export interface StoppedTree {
  /** Their steps in this process are cut off after the commit ({@link cutOff}). */
  readonly stopped: readonly RuntimeTaskRow[];
  readonly ends: readonly TaskEndRecord[];
}

/**
 * What an end wrote: the task's last row, the descendants a failure stopped and every end of the
 * transaction, this one first.
 */
export interface EndedTask extends StoppedTree {
  readonly row: RuntimeTaskRow;
}

/** The fields every log record about a task carries. */
export const taskLogFields = (task: RuntimeTaskRow) => ({
  taskId: task.taskId,
  rootId: task.rootId,
  ownerId: task.ownerId,
  type: task.type,
  stepNo: task.stepNo,
  attempt: task.attempt,
});

/** After the commit: one record per ended task. The failure text is not cut. */
export function logTaskEnds(
  logger: Logger,
  ends: readonly TaskEndRecord[],
): void {
  for (const end of ends) {
    const fields = {
      ...taskLogFields(end.row),
      from: end.from,
      to: end.status,
      cause: end.cause,
      ...(end.failure && {
        failureReason: end.failure.reason,
        failureMessage: end.failure.message,
      }),
      noticeId: end.noticeId,
      parentWoken: end.parentWoken,
      revived: end.revived,
      ...(end.stoppedIds.length > 0 && { stoppedIds: end.stoppedIds }),
    };
    if (end.status === failed) logger.warn('task ended', fields);
    else logger.info('task ended', fields);
  }
}

/** What cutting steps off needs: this process's steps and the objects of live tasks. */
export interface CutOffDeps {
  running: RunningTaskRegistry;
  live: LiveTasks;
}

/** How a task ends. */
export interface TaskEnd {
  status: typeof completed | typeof failed | typeof stopped;
  /** The outcome of a `completed` task. */
  result?: unknown;
  /** The reason of a `failed` task. */
  failure?: TaskFailure;
  /** Further columns of the same write, e.g. the step counters. */
  fields?: TaskValues;
  /** `attempt + 1`: the step in flight, if any, is no longer current (Invariant 1). */
  fence?: boolean;
  cause: TaskEndCause;
}

/**
 * A guarded write, by its status and attempt, of a task row the caller's transaction holds: the
 * row a write of this transaction returned (`Tasks.hold`, `Tasks.transition`). No other writer
 * changes such a row, so a write that matches nothing is a bug; it rolls the transaction back.
 */
export async function writeHeld(
  tasks: Tasks,
  task: RuntimeTaskRow,
  change: TaskChange,
): Promise<RuntimeTaskRow> {
  const row = await tasks.transition(
    {
      taskId: task.taskId,
      from: [TaskStatusSchema.parse(task.status)],
      attempt: task.attempt,
    },
    change,
  );
  if (!row) throw new Error(`Write of held task ${task.taskId} matched no row`);
  return row;
}

/**
 * The child's one end notice in the parent's inbox (KD-2, «Сообщение `child_finished`»): never with
 * `revive`, so it does not wake a finished parent; the parent's wake-up rule reads the child's
 * `awaited_step` and status.
 */
async function notifyParent(
  inbox: Inbox,
  child: RuntimeTaskRow,
): Promise<InsertedMessage | undefined> {
  if (child.parentId === null) return undefined;
  const finishedAt = child.finishedAt ?? new Date();
  const status = TaskEndStatusSchema.parse(child.status);
  const payload: ChildFinishedPayload = {
    taskId: child.taskId,
    status,
    ...(status === completed && { result: child.result }),
    ...(status === failed && { failure: child.failure as TaskFailure }),
    durationMs: Math.max(0, finishedAt.getTime() - child.createdAt.getTime()),
  };
  return inbox.insertMessage({
    recipientId: child.parentId,
    ownerId: child.ownerId,
    kind: CHILD_FINISHED_KIND,
    payload,
    revive: false,
    finishedChild: { awaitedStep: child.awaitedStep, status },
  });
}

/**
 * The one procedure "a task ends → its parent is told" (KD-3, KD-5, Invariant 5), in the caller's
 * transaction: the final status; for a `failed` task the stop of its unfinished
 * descendants, top-down ({@link stopTree}); every end hook, each in its own savepoint; one
 * `child_finished` to the parent, which wakes it by the wake-up rule (KD-2); and — when the task completed or failed while a message with `revive` arrived — `queued` again
 * (Invariant 9). A stop never revives. `task` is a row the transaction holds
 * ({@link writeHeld}). The caller logs the returned ends after the commit ({@link logTaskEnds}).
 */
export async function endTask(
  deps: TaskEndDeps,
  task: RuntimeTaskRow,
  end: TaskEnd,
): Promise<EndedTask> {
  const ended = await writeHeld(deps.tasks, task, {
    kind: 'set',
    status: end.status,
    fields: {
      ...end.fields,
      ...(end.status === completed && { result: end.result ?? null }),
      ...(end.status === failed && { failure: end.failure }),
    },
    fence: end.fence,
  });
  const descendants: StoppedTree =
    end.status === failed
      ? await stopLevels(
          deps,
          await deps.taskRows.listChildren([ended.taskId]),
          'parent_failed',
        )
      : { stopped: [], ends: [] };
  await runEndHooks(deps, ended);
  const revives =
    end.status !== stopped && (await deps.inbox.hasPendingRevive(ended.taskId));
  // The child's own row is written above, before the notice takes the parent's row: a sibling's end
  // that takes the parent's row after this commit counts this child finished (wake-up rule, KD-2).
  const notice = await notifyParent(deps.inbox, ended);
  let row = ended;
  if (revives) {
    row = await writeHeld(deps.tasks, ended, {
      kind: 'set',
      status: queued,
      fields: { result: null, failure: null },
    });
  }
  const record: TaskEndRecord = {
    row,
    from: task.status,
    status: end.status,
    cause: end.cause,
    failure: end.failure,
    noticeId: notice?.messageId,
    parentWoken: notice?.woken ?? false,
    revived: revives,
    stoppedIds: descendants.stopped.map((stoppedTask) => stoppedTask.taskId),
  };
  return {
    row,
    stopped: descendants.stopped,
    ends: [record, ...descendants.ends],
  };
}

/**
 * Every end hook on the ended row, each in its own savepoint (KD-5): a hook that throws rolls back
 * only its writes and is logged, and the end goes on; an error after which the transaction cannot
 * go on is thrown, so the whole end is repeated (KD-7).
 */
async function runEndHooks(
  deps: TaskEndDeps,
  ended: RuntimeTaskRow,
): Promise<void> {
  const input: TaskEndHookInput = {
    taskId: ended.taskId,
    rootId: ended.rootId,
    parentId: ended.parentId,
    ownerId: ended.ownerId,
    type: ended.type,
    status: TaskEndStatusSchema.parse(ended.status),
    failure: ended.failure as TaskFailure | null,
    finishedAt: ended.finishedAt ?? new Date(),
  };
  for (const { name, hook } of deps.endHooks.list()) {
    const startedAt = Date.now();
    const outcome = await inSavepoint(deps.db, () => hook(input));
    if (outcome.ok) continue;
    deps.logger.error('task end hook failed; its writes rolled back', {
      hook: name,
      taskId: ended.taskId,
      rootId: ended.rootId,
      ownerId: ended.ownerId,
      type: ended.type,
      status: input.status,
      durationMs: Date.now() - startedAt,
      error: outcome.error,
    });
  }
}

/**
 * Stops `top` (unless finished) and every unfinished descendant, top-down, level by level, in the
 * caller's transaction; returns the stopped rows, `top` first. Each task is taken by a write of its
 * row as it is now (`Tasks.hold`) and ended; its children are read after that. A commit or a
 * creation that adds a child writes the parent's row too, so it came before the parent's stop, and
 * its child is read here, or it comes after and is refused.
 */
export function stopTree(
  deps: TaskEndDeps,
  top: RuntimeTaskRow,
): Promise<StoppedTree> {
  return stopLevels(deps, [top], 'stop');
}

/** {@link stopTree} from a first level of tasks down. */
async function stopLevels(
  deps: TaskEndDeps,
  first: readonly RuntimeTaskRow[],
  cause: TaskEndCause,
): Promise<StoppedTree> {
  const stoppedTasks: RuntimeTaskRow[] = [];
  const ends: TaskEndRecord[] = [];
  for (
    let level = first;
    level.length > 0;
    level = await deps.taskRows.listChildren(level.map((task) => task.taskId))
  ) {
    for (const { taskId } of level) {
      const task = await deps.tasks.hold({ taskId, from: UNFINISHED_STATUSES });
      if (!task) continue;
      const ended = await endTask(deps, task, {
        status: stopped,
        fields: { recoveries: 0 },
        fence: true,
        cause,
      });
      stoppedTasks.push(ended.row);
      ends.push(...ended.ends);
    }
  }
  return { stopped: stoppedTasks, ends };
}

/**
 * After the commit: cuts off this process's steps of the tasks whose attempt the transaction
 * raised, and lets their live objects go — a cut-off step may have written what its object has not
 * taken in.
 */
export function cutOff(
  deps: CutOffDeps,
  changed: readonly RuntimeTaskRow[],
  reason: StepSignalReason,
): void {
  if (changed.length === 0) return;
  for (const task of changed) {
    // Not awaited: the steps end when their handlers answer the signal.
    void deps.running.abortTask(task.taskId, reason, task.attempt);
  }
  deps.live.evict(changed.map((task) => task.taskId));
}
