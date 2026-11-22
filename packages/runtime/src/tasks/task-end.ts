import {
  CHILD_FINISHED_KIND,
  RuntimeEventTypeSchema,
  TASKS_FINISHED_KIND,
  TaskEndStatusSchema,
  type TasksFinishedPayload,
  TaskStatusSchema,
} from '@agent-os/contracts';
import type { RuntimeTrackersRepository } from '@agent-os/db';
import type { EventLog } from '../events/event-log';
import type { Inbox } from '../messaging/inbox';
import type {
  TaskChange,
  TaskFailure,
  TaskFields,
  TaskRow,
} from './guarded-transition';
import type { Tasks } from './tasks';

const { queued, completed, failed, stopped } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/** Bound of a failure message in an event payload, which is at most 8 KiB. */
const EVENT_MESSAGE_MAX = 1_000;

/** Services the end of a task writes through. */
export interface TaskEndDeps {
  tasks: Tasks;
  trackers: RuntimeTrackersRepository;
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

/**
 * A guarded write, by its status and attempt, of a task row the caller's transaction holds: the
 * row a write of this transaction returned (`Tasks.hold`, `Tasks.transition`). No other writer
 * changes such a row, so a write that matches nothing is a bug; it rolls the transaction back.
 */
export async function writeHeld(
  tasks: Tasks,
  task: TaskRow,
  change: TaskChange,
): Promise<TaskRow> {
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
 * The child's end notice in the parent's inbox (design-runtime.md, Очередь): never with `revive`,
 * so it does not wake a finished parent.
 */
async function notifyParent(inbox: Inbox, child: TaskRow): Promise<void> {
  if (child.parentId === null) return;
  const finishedAt = child.finishedAt ?? new Date();
  const status = TaskStatusSchema.parse(child.status);
  await inbox.insertMessage({
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

/**
 * The end of a task of an open tracker (deep-agents/design-task.md, KD-2), in the caller's
 * transaction: no `child_finished`; when no task of the tracker is unfinished
 * any more, the tracker is finished and the owner gets its one `tasks_finished`. The unfinished
 * tasks are counted, not a counter kept: a revived task makes the tracker wait for it again, and
 * a task that `revives` at once is not reported at all. Returns `false` when the task has no open
 * tracker, so the caller notifies the parent as usual.
 *
 * The recount follows a write of the tracker row (`holdOpen`): two tasks of one tracker that end
 * at once recount one after the other, and the second sees the first one ended.
 */
async function reportToTracker(
  deps: TaskEndDeps,
  child: TaskRow,
  revives: boolean,
): Promise<boolean> {
  if (child.trackerId === null) return false;
  const tracker = await deps.trackers.holdOpen(child.trackerId);
  if (!tracker) return false;
  if (revives) return true;
  const ended: TasksFinishedPayload['tasks'] = [];
  for (const task of await deps.trackers.taskStatuses(tracker.trackerId)) {
    const status = TaskEndStatusSchema.safeParse(task.status);
    if (!status.success) return true;
    ended.push({ taskId: task.taskId, status: status.data });
  }
  await deps.trackers.finish(tracker.trackerId);
  const payload: TasksFinishedPayload = {
    trackerId: tracker.trackerId,
    tasks: ended,
  };
  await deps.inbox.insertMessage({
    recipientId: tracker.taskId,
    ownerId: child.ownerId,
    kind: TASKS_FINISHED_KIND,
    sender: child.taskId,
    payload,
    revive: false,
  });
  return true;
}

/**
 * The one procedure "a task ends → its parent is told" (KD-3, Invariant 5), in the caller's
 * transaction: the final status with its event, one
 * `child_finished` to the parent (for a task of an open tracker, the tracker's recount instead),
 * and — when the task completed or failed while a message with `revive` arrived — `queued` again
 * with `task.queued` (Invariant 9). A stop never revives. Returns the last row. `task` is a row
 * the transaction holds ({@link writeHeld}).
 */
export async function endTask(
  deps: TaskEndDeps,
  task: TaskRow,
  end: TaskEnd,
): Promise<TaskRow> {
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
  await deps.events.append({
    type: STATUS_EVENT[end.status],
    task: ended,
    payload: {
      from: task.status,
      ...(end.failure && { failure: eventFailure(end.failure) }),
    },
  });
  const revives =
    end.status !== stopped && (await deps.inbox.hasPendingRevive(ended.taskId));
  if (!(await reportToTracker(deps, ended, revives))) {
    await notifyParent(deps.inbox, ended);
  }
  if (!revives) return ended;
  const revived = await writeHeld(deps.tasks, ended, {
    kind: 'set',
    status: queued,
    fields: { result: null, failure: null },
  });
  await deps.events.append({
    type: EVENT['task.queued'],
    task: revived,
    payload: { cause: 'revive', from: ended.status },
  });
  return revived;
}
