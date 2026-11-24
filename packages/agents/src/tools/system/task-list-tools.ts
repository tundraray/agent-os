import type { ConversationTasksRepository, SessionTask } from '@agent-os/db';
import type { Logger } from '@agent-os/common';
import { SessionTaskStatusSchema } from '@agent-os/contracts';
import { z } from 'zod';

import { descriptionLine } from '../../chat-listing';
import { taskLine } from './task-list-block';
import type { InCommitAgentTool, ToolCaller, ToolRunResult } from '../tool';
import {
  decideTaskChange,
  TASK_DELETED,
  type TaskChangeCall,
  type TaskCreateArgs,
  type TaskUpdateArgs,
} from './task-list-rules';

export const TASK_CREATE_TOOL = 'task_create';
const TASK_UPDATE_TOOL = 'task_update';
const TASK_GET_TOOL = 'task_get';
const TASK_LIST_TOOL = 'task_list';

/** The four task-list tools an agent that keeps a task list declares (design-task-list.md KD-2). */
export const TASK_LIST_TOOLS = [
  TASK_CREATE_TOOL,
  TASK_UPDATE_TOOL,
  TASK_GET_TOOL,
  TASK_LIST_TOOL,
] as const;

/** Field limits of Contract «Инструменты». */
const SUBJECT_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 4000;
const ACTIVE_FORM_MAX_LENGTH = 200;
const OWNER_MAX_LENGTH = 100;

/**
 * A one-line field: collapsed to one line before its length is checked, so a text copied from a tool result
 * cannot fake task lines in the system text (Security Considerations).
 */
function oneLine(max: number) {
  return z.string().overwrite(descriptionLine).min(1).max(max);
}

const taskNumber = z.number().int().positive();

const TaskCreateArgsSchema = z.object({
  subject: oneLine(SUBJECT_MAX_LENGTH).describe(
    'A short title of the task, in the imperative: "Check the orders"',
  ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(DESCRIPTION_MAX_LENGTH)
    .describe('What has to be done and how you will know it is done'),
  activeForm: oneLine(ACTIVE_FORM_MAX_LENGTH)
    .optional()
    .describe(
      'The task in the present continuous, shown while it is in progress: "Checking the orders"',
    ),
}) satisfies z.ZodType<TaskCreateArgs>;

const TaskUpdateArgsSchema = z.object({
  taskId: taskNumber.describe('The number of the task'),
  status: z
    .enum([...SessionTaskStatusSchema.options, TASK_DELETED])
    .optional()
    .describe(
      'in_progress before you start the task, completed right after it is done, deleted when it is no longer needed',
    ),
  subject: oneLine(SUBJECT_MAX_LENGTH).optional().describe('A new title'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe('A new description'),
  activeForm: oneLine(ACTIVE_FORM_MAX_LENGTH)
    .optional()
    .describe('A new present continuous form'),
  owner: oneLine(OWNER_MAX_LENGTH)
    .optional()
    .describe('A label of who works on the task'),
  addBlockedBy: z
    .array(taskNumber)
    .optional()
    .describe(
      'Numbers of tasks that must be completed before this one can start',
    ),
  addBlocks: z
    .array(taskNumber)
    .optional()
    .describe(
      'Numbers of tasks that cannot start before this one is completed',
    ),
}) satisfies z.ZodType<TaskUpdateArgs>;
type TaskCreateInput = z.infer<typeof TaskCreateArgsSchema>;
type TaskUpdateInput = z.infer<typeof TaskUpdateArgsSchema>;

const TaskGetArgsSchema = z.object({
  taskId: taskNumber.describe('The number of the task'),
});
type TaskGetInput = z.infer<typeof TaskGetArgsSchema>;
const TaskListArgsSchema = z.object({});
type TaskListInput = z.infer<typeof TaskListArgsSchema>;

const CREATE_DESCRIPTION = [
  'Add a task to your task list; it starts pending and gets the next number.',
  'Keep a list when the work takes three or more steps, when the employee gives you a list of things to do, or',
  'when the work is long. Your list is shown at the end of your instructions on every step.',
  'Mark a task in_progress with task_update before you start it and completed right after it is done; never mark',
  'unfinished work completed. Keep one task in progress at a time. Set the order with addBlockedBy and addBlocks.',
].join(' ');

const UPDATE_DESCRIPTION = [
  'Change a task of your list: only the fields you give change, and dependencies are only added.',
  'Set in_progress before you start a task and completed as soon as it is done; keep one task in progress.',
  'A task cannot become in_progress or completed while a task blocking it is not completed.',
  'Never mark a task completed while its work is unfinished: keep it in_progress, or add a task for what blocks it.',
  'Use deleted for a task that is no longer needed. An agent other than the main chat cannot finish its turn',
  'while a task is pending or in_progress.',
].join(' ');

const GET_DESCRIPTION =
  'Read one task of your list whole: its status, label, dependencies and description.';

const LIST_DESCRIPTION =
  'List your tasks, one line each: number, status, title, blockers and label, without descriptions.';

/**
 * The rule of a fixed list (self-learning design-training.md, «Пул задач тренера»): its set and order stay, and
 * its code tasks move by code only. `true` — the call breaks it.
 */
function breaksFixedList(
  call: TaskChangeCall,
  fixed: readonly number[],
): boolean {
  if (call.tool !== 'update') return false;
  const { args } = call;
  return (
    args.status === TASK_DELETED ||
    (args.addBlockedBy?.length ?? 0) > 0 ||
    (args.addBlocks?.length ?? 0) > 0 ||
    fixed.includes(args.taskId)
  );
}

/** The fields of `task_update` the log may name. */
const UPDATE_FIELDS = new Set(Object.keys(TaskUpdateArgsSchema.shape));

/** Numbers only out of arguments the model wrote, before they were checked: anything else is dropped. */
function numbersOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

/** Statuses only, for the same reason. */
function statusOf(value: unknown): string | undefined {
  const parsed = TaskUpdateArgsSchema.shape.status.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The log fields of a call: the caller's ids and the call id, never a task's texts (Contract «Журнал»). */
function idsOf(caller: ToolCaller, callId: string): Record<string, unknown> {
  return {
    agentId: caller.agentId,
    rootId: caller.rootId,
    ownerId: caller.ownerId,
    callId,
  };
}

/** The task whole, as `task_get` answers: number, title, status, label, blockers, whom it blocks, description. */
function taskDetails(task: SessionTask, tasks: readonly SessionTask[]): string {
  const blocks = tasks
    .filter((other) => other.blockedBy.includes(task.number))
    .map((other) => other.number);
  return [
    `Task ${task.number}: ${task.subject}`,
    `Status: ${task.status}`,
    ...(task.activeForm === null ? [] : [`Active form: ${task.activeForm}`]),
    ...(task.owner === null ? [] : [`Owner: ${task.owner}`]),
    `Blocked by: ${task.blockedBy.length === 0 ? 'none' : task.blockedBy.join(', ')}`,
    `Blocks: ${blocks.length === 0 ? 'none' : blocks.join(', ')}`,
    'Description:',
    task.description,
  ].join('\n');
}

/**
 * The four task tools (design-task-list.md KD-1 – KD-3, Contract «Инструменты», «Журнал»). Each runs in the
 * step's commit: the list and the session's counter are read in that transaction, the rules decide, and the
 * change is written with the call's `tool_result`, so a replayed step never writes a task twice (DC-3). The
 * session is the caller's own — its id comes from the call's context, never from the arguments. The log names
 * the numbers, statuses and field names only; `loggedArgs` likewise.
 */
export function createTaskListTools(deps: {
  readonly sessionTaskRows: ConversationTasksRepository;
  readonly logger: Logger;
}): [
  InCommitAgentTool<TaskCreateInput>,
  InCommitAgentTool<TaskUpdateInput>,
  InCommitAgentTool<TaskGetInput>,
  InCommitAgentTool<TaskListInput>,
] {
  const logger = deps.logger.child({ service: 'agents.session-tasks' });
  const { sessionTaskRows } = deps;

  async function change(
    call: TaskChangeCall,
    input: { readonly caller: ToolCaller; readonly callId: string },
  ): Promise<ToolRunResult> {
    const ids = idsOf(input.caller, input.callId);
    const { fixedTasks } = input.caller;
    if (fixedTasks !== null && breaksFixedList(call, fixedTasks)) {
      logger.info('task call refused', {
        ...ids,
        tool: call.tool,
        rule: 'fixed_list',
      });
      return {
        kind: 'refused',
        reason: 'invalid_arguments',
        text: `Your task list is fixed: no task is deleted or gets new dependencies, and tasks ${fixedTasks.join(', ')} are moved by the platform only.`,
      };
    }
    const state = await sessionTaskRows.read(input.caller.agentId);
    const decision = decideTaskChange(state, call);
    if (decision.kind === 'refused') {
      logger.info('task call refused', {
        ...ids,
        tool: call.tool,
        field: decision.field,
        rule: decision.rule,
      });
      return {
        kind: 'refused',
        reason: 'invalid_arguments',
        text: decision.text,
      };
    }
    await sessionTaskRows.write(input.caller.agentId, decision);
    logger.info(`task ${decision.event.action}`, {
      ...ids,
      ...decision.event,
      tasks:
        state.tasks.length +
        (decision.event.action === 'created' ? 1 : 0) -
        decision.deleted.length,
    });
    return { kind: 'done', outcome: 'success', text: decision.text };
  }

  const create: InCommitAgentTool<TaskCreateInput> = {
    name: TASK_CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    argsSchema: TaskCreateArgsSchema,
    mode: 'in_commit',
    loggedArgs: (args) => ({
      fields: Object.keys(args).filter(
        (key) => key in TaskCreateArgsSchema.shape,
      ),
    }),
    execute: ({ args, caller, callId }) =>
      change({ tool: 'create', args }, { caller, callId }),
  };

  const update: InCommitAgentTool<TaskUpdateInput> = {
    name: TASK_UPDATE_TOOL,
    description: UPDATE_DESCRIPTION,
    argsSchema: TaskUpdateArgsSchema,
    mode: 'in_commit',
    loggedArgs: (args) => ({
      taskId: typeof args.taskId === 'number' ? args.taskId : null,
      status: statusOf(args.status) ?? null,
      fields: Object.keys(args).filter((key) => UPDATE_FIELDS.has(key)),
      addBlockedBy: numbersOf(args.addBlockedBy),
      addBlocks: numbersOf(args.addBlocks),
    }),
    execute: ({ args, caller, callId }) =>
      change({ tool: 'update', args }, { caller, callId }),
  };

  const get: InCommitAgentTool<TaskGetInput> = {
    name: TASK_GET_TOOL,
    description: GET_DESCRIPTION,
    argsSchema: TaskGetArgsSchema,
    mode: 'in_commit',
    loggedArgs: (args) => ({
      taskId: typeof args.taskId === 'number' ? args.taskId : null,
    }),
    async execute({ args, caller, callId }) {
      const tasks = await sessionTaskRows.list(caller.agentId);
      const task = tasks.find((candidate) => candidate.number === args.taskId);
      logger.info('task read', {
        ...idsOf(caller, callId),
        number: args.taskId,
        found: task !== undefined,
      });
      if (task === undefined)
        return {
          kind: 'done',
          outcome: 'empty',
          text: `There is no task ${args.taskId}`,
        };
      return {
        kind: 'done',
        outcome: 'success',
        text: taskDetails(task, tasks),
      };
    },
  };

  const list: InCommitAgentTool<TaskListInput> = {
    name: TASK_LIST_TOOL,
    description: LIST_DESCRIPTION,
    argsSchema: TaskListArgsSchema,
    mode: 'in_commit',
    loggedArgs: () => ({}),
    async execute({ caller, callId }) {
      const tasks = await sessionTaskRows.list(caller.agentId);
      logger.info('task list read', {
        ...idsOf(caller, callId),
        tasks: tasks.length,
      });
      if (tasks.length === 0)
        return { kind: 'done', outcome: 'empty', text: 'No tasks' };
      const text = tasks.map((task) => taskLine(task, task.subject)).join('\n');
      return { kind: 'done', outcome: 'success', text };
    },
  };

  return [create, update, get, list];
}
