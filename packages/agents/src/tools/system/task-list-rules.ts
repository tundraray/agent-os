import {
  type SessionTaskStatus,
  SessionTaskStatusSchema,
} from '@agent-os/contracts';

import type { SessionTask } from '@agent-os/db';

/** At most this many tasks in one session's list; `task_create` past it is refused (Data Model). */
const TASK_LIST_MAX_TASKS = 50;

const { pending, in_progress, completed } = SessionTaskStatusSchema.enum;

/** `task_update`'s status: a stored one, or `deleted`, which takes the task out of the list. */
export const TASK_DELETED = 'deleted';
export type TaskUpdateStatus = SessionTaskStatus | typeof TASK_DELETED;

/** `task_create` as its schema checked it: one-line fields already collapsed. */
export interface TaskCreateArgs {
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string | undefined;
}

/** `task_update` as its schema checked it: only the fields given change. */
export interface TaskUpdateArgs {
  readonly taskId: number;
  readonly status?: TaskUpdateStatus | undefined;
  readonly subject?: string | undefined;
  readonly description?: string | undefined;
  readonly activeForm?: string | undefined;
  readonly owner?: string | undefined;
  readonly addBlockedBy?: readonly number[] | undefined;
  readonly addBlocks?: readonly number[] | undefined;
}

/** A call that changes the list. */
export type TaskChangeCall =
  | { readonly tool: 'create'; readonly args: TaskCreateArgs }
  | { readonly tool: 'update'; readonly args: TaskUpdateArgs };

/** The session's list as the step's transaction read it. */
export interface TaskListState {
  readonly tasks: readonly SessionTask[];
  /** `conversations.last_task_number`: the last number given, 0 before the first task. */
  readonly lastNumber: number;
}

/** What the change did to one task, for the log: numbers and statuses only (Contract «Журнал»). */
export interface TaskChangeEvent {
  readonly action: 'created' | 'updated' | 'deleted';
  readonly number: number;
  readonly statusBefore: SessionTaskStatus | null;
  readonly statusAfter: SessionTaskStatus | null;
  /** Names of the fields the call changed. */
  readonly fields: readonly string[];
}

/** An accepted call: the rows to write, the numbers to delete, the new counter and the text the model reads. */
export interface TaskChange {
  readonly kind: 'change';
  /** Tasks created or changed, whole, as they are after the call. */
  readonly written: readonly SessionTask[];
  readonly deleted: readonly number[];
  readonly lastNumber: number;
  readonly text: string;
  readonly event: TaskChangeEvent;
}

/** A refused call: the text names the field and the rule; `field` and `rule` go to the log. */
export interface TaskRefusal {
  readonly kind: 'refused';
  readonly field: string;
  readonly rule: string;
  readonly text: string;
}

function refused(field: string, rule: string, text: string): TaskRefusal {
  return { kind: 'refused', field, rule, text };
}

function create(
  state: TaskListState,
  args: TaskCreateArgs,
): TaskChange | TaskRefusal {
  if (state.tasks.length >= TASK_LIST_MAX_TASKS) {
    return refused(
      'task_create',
      'list_full',
      `The list already holds ${TASK_LIST_MAX_TASKS} tasks, the most it may hold: delete finished tasks first.`,
    );
  }
  const number = state.lastNumber + 1;
  const task: SessionTask = {
    number,
    subject: args.subject,
    description: args.description,
    activeForm: args.activeForm ?? null,
    status: pending,
    owner: null,
    blockedBy: [],
  };
  return {
    kind: 'change',
    written: [task],
    deleted: [],
    lastNumber: number,
    text: `Task ${number} created: ${task.subject}`,
    event: {
      action: 'created',
      number,
      statusBefore: null,
      statusAfter: pending,
      fields: [],
    },
  };
}

function remove(state: TaskListState, task: SessionTask): TaskChange {
  // Deleting a task takes its number out of every list of blockers.
  const written = state.tasks
    .filter((other) => other.blockedBy.includes(task.number))
    .map((other) => ({
      ...other,
      blockedBy: other.blockedBy.filter((number) => number !== task.number),
    }));
  return {
    kind: 'change',
    written,
    deleted: [task.number],
    lastNumber: state.lastNumber,
    text: `Task ${task.number} deleted`,
    event: {
      action: 'deleted',
      number: task.number,
      statusBefore: task.status,
      statusAfter: null,
      fields: [],
    },
  };
}

/** Whether `from` waits, directly or through other tasks, on `target`. */
function waitsOn(
  blockers: ReadonlyMap<number, readonly number[]>,
  from: number,
  target: number,
): boolean {
  const seen = new Set<number>();
  const queue = [from];
  for (
    let current = queue.pop();
    current !== undefined;
    current = queue.pop()
  ) {
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(blockers.get(current) ?? []));
  }
  return false;
}

/** A new edge: `task` waits on `blocker`; `field` is the argument that asked for it. */
interface Edge {
  readonly field: 'addBlockedBy' | 'addBlocks';
  readonly task: number;
  readonly blocker: number;
}

function edgesOf(args: TaskUpdateArgs): Edge[] {
  return [
    ...(args.addBlockedBy ?? []).map((blocker): Edge => ({
      field: 'addBlockedBy',
      task: args.taskId,
      blocker,
    })),
    ...(args.addBlocks ?? []).map((task): Edge => ({
      field: 'addBlocks',
      task,
      blocker: args.taskId,
    })),
  ];
}

/**
 * The edges added one by one to `blockers`: a number not in the list, an edge to the task itself and an edge
 * that closes a cycle are refused.
 */
function addEdges(
  blockers: Map<number, readonly number[]>,
  edges: readonly Edge[],
): TaskRefusal | null {
  for (const edge of edges) {
    const other = edge.field === 'addBlockedBy' ? edge.blocker : edge.task;
    if (!blockers.has(other)) {
      return refused(
        edge.field,
        'unknown_task',
        `${edge.field}: there is no task ${other} in the list.`,
      );
    }
    if (edge.task === edge.blocker) {
      return refused(
        edge.field,
        'self_edge',
        `${edge.field}: a task cannot block itself.`,
      );
    }
    const current = blockers.get(edge.task) ?? [];
    if (current.includes(edge.blocker)) continue;
    if (waitsOn(blockers, edge.blocker, edge.task)) {
      return refused(
        edge.field,
        'cycle',
        `${edge.field}: task ${edge.blocker} already waits on task ${edge.task}, so task ${edge.task} cannot wait on it; dependencies cannot form a cycle.`,
      );
    }
    blockers.set(edge.task, [...current, edge.blocker]);
  }
  return null;
}

/** The fields of `task_update` other than `taskId` and `status`, in the order the answer names them. */
const FIELDS = [
  'subject',
  'description',
  'activeForm',
  'owner',
  'addBlockedBy',
  'addBlocks',
] as const;

function update(
  state: TaskListState,
  args: TaskUpdateArgs,
): TaskChange | TaskRefusal {
  const task = state.tasks.find(
    (candidate) => candidate.number === args.taskId,
  );
  if (task === undefined)
    return refused(
      'taskId',
      'unknown_task',
      `There is no task ${args.taskId}.`,
    );
  if (args.status === TASK_DELETED) return remove(state, task);
  const fields = FIELDS.filter((field) => args[field] !== undefined);
  if (args.status === undefined && fields.length === 0) {
    return refused(
      'taskId',
      'nothing_to_change',
      `Nothing to change: give task ${task.number} a status or a field.`,
    );
  }

  const blockers = new Map(
    state.tasks.map((candidate) => [candidate.number, candidate.blockedBy]),
  );
  const edgeRefusal = addEdges(blockers, edgesOf(args));
  if (edgeRefusal !== null) return edgeRefusal;

  const status = args.status ?? task.status;
  if (
    (status === in_progress || status === completed) &&
    status !== task.status
  ) {
    const open = (blockers.get(task.number) ?? []).filter(
      (number) =>
        state.tasks.find((candidate) => candidate.number === number)?.status !==
        completed,
    );
    if (open.length > 0) {
      return refused(
        'status',
        'blocked',
        `Task ${task.number} cannot become ${status}: it is blocked by ${open.join(', ')}, not completed yet.`,
      );
    }
  }

  const changed: SessionTask = {
    ...task,
    status,
    subject: args.subject ?? task.subject,
    description: args.description ?? task.description,
    activeForm: args.activeForm ?? task.activeForm,
    owner: args.owner ?? task.owner,
    blockedBy: blockers.get(task.number) ?? [],
  };
  const written = state.tasks.flatMap((candidate) => {
    if (candidate.number === task.number) return [changed];
    const after = blockers.get(candidate.number) ?? [];
    return after.length === candidate.blockedBy.length
      ? []
      : [{ ...candidate, blockedBy: after }];
  });
  const parts = [
    ...(args.status === undefined ? [] : [`status ${task.status} → ${status}`]),
    ...fields,
  ];
  return {
    kind: 'change',
    written,
    deleted: [],
    lastNumber: state.lastNumber,
    text: `Task ${task.number} updated: ${parts.join('; ')}`,
    event: {
      action: 'updated',
      number: task.number,
      statusBefore: task.status,
      statusAfter: status,
      fields,
    },
  };
}

/**
 * The rules of the session's task list (design-task-list.md KD-1, KD-3, Contract «Инструменты»; pure-decision.md):
 * a new task takes the number after the last one given, so no number comes back; `task_update` changes only the
 * fields given and only adds edges; `deleted` takes the task and its number out of every list of blockers. A full
 * list, an unknown task, an empty update, an edge to a number not in the list, to the task itself or one that
 * closes a cycle, and `in_progress` or `completed` while a blocker is not completed are refused with a text that
 * names the field and the rule; the list does not change then.
 */
export function decideTaskChange(
  state: TaskListState,
  call: TaskChangeCall,
): TaskChange | TaskRefusal {
  return call.tool === 'create'
    ? create(state, call.args)
    : update(state, call.args);
}
