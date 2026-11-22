import type { Logger } from '@agent-os/common';
import { AGENT_TASK_TYPE, ToolOutcomeSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Runtime, RuntimeTx, StepEffects, Tracker, TrackerTask } from '@agent-os/runtime';
import { z } from 'zod';

import { descriptionLine } from '../../chat-listing';
import type { CallState } from '../../history/call-state';
import type { HistoryEntry } from '../../history/history';
import type { DeepAgentSnapshot } from '../../start/snapshot';
import {
  delegationTeam,
  type RunDefinition,
  snapshotDefinition,
  subagentSnapshot,
  TASK_TOOL,
} from '../../start/snapshot-definition';
import { type CallEnding, callRecords } from '../../store/call-records.repository';
import { history } from '../../store/history.repository';
import { sessionTasks } from '../../store/session-tasks.repository';
import { AnswerFieldSchema, type SessionInput, sessions, type StoreReader } from '../../store/sessions.repository';
import {
  type StoredToolResult,
  type ToolResultSettingsRow,
  toolResults,
} from '../../store/tool-results.repository';
import { wrapperText } from '../large-result';
import type { InCommitAgentTool, ToolCaller } from '../tool';
import {
  type AcceptedDelegation,
  type AnswerField,
  type DelegationCall,
  type DelegationDecision,
  decideDelegations,
  resultTable,
  TASK_TABLE_MAX_CHARS,
  type TableRow,
  type TaskArgs,
} from './delegation-rules';
import { type DeepAgentBrief, DeepAgentBriefSchema } from './start-deep-agent';
import { decideTaskChange } from './task-rules';

/** Field limits of Contract «Инструмент `task`». */
const ASSIGNMENT_MAX_LENGTH = 8_000;
const ITEM_MAX_LENGTH = 2_000;
const ANSWER_FIELDS_MAX = 10;

/** The arguments of `task` with every field; a session gets the fields its flags allow (`taskArgsSchema`). */
export const TaskArgsSchema = z.strictObject({
  subagentType: z.string().min(1).describe('The name of the subagent, as the list below gives it'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(ASSIGNMENT_MAX_LENGTH)
    .optional()
    .describe('One assignment: everything the subagent needs to do the work'),
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(ASSIGNMENT_MAX_LENGTH)
    .optional()
    .describe('What to do for each item of items; give it with items instead of description'),
  items: z
    .array(z.string().trim().min(1).max(ITEM_MAX_LENGTH))
    .optional()
    .describe('The items, one subagent each; the result is a table with a row per item'),
  answerFields: z
    .array(AnswerFieldSchema)
    .max(ANSWER_FIELDS_MAX)
    .optional()
    .describe('The fields of the answer: the subagent then answers with one JSON object of them'),
  taskId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The number of a task of your list this work is for'),
}) satisfies z.ZodType<TaskArgs>;

/**
 * The schema of `task` a session is offered (DC-6): without the list fields when the list form is off and
 * without `taskId` without a task list. A key outside it is refused, as any extra key is.
 */
export function taskArgsSchema(definition: Pick<RunDefinition, 'listDelegation' | 'taskList'>): z.ZodType<TaskArgs> {
  return TaskArgsSchema.omit({
    ...(definition.listDelegation ? {} : { instruction: true, items: true }),
    ...(definition.taskList ? {} : { taskId: true }),
  });
}

/** The description of `task` (Contract «Инструмент `task`»): the forms, then the subagents with their limits. */
export function describeTask(
  definition: Pick<RunDefinition, 'listDelegation' | 'taskList' | 'startable'>,
): string {
  return [
    'Give work to a subagent. It works in the background on its own and sees only what you give it; the call’s result is its last message.',
    'You are resumed once, when every task call of your answer has finished: nothing is to be polled.',
    definition.listDelegation
      ? 'Give description for one assignment, or instruction with items to run one subagent per item: that call’s result is a table with a row per item.'
      : 'Give description: the whole assignment.',
    'With answerFields the subagent answers with one JSON object of those fields.',
    ...(definition.taskList
      ? [
          'With taskId the work is for that task of your list: it becomes in_progress with the subagent as its owner, and completed when every subagent of the call has completed.',
        ]
      : []),
    'Subagents you may call (subagentType):',
    ...definition.startable.map((line) => `- ${line}`),
  ].join('\n');
}

/** The fields of a call the log may name: never the assignment, the instruction, the items or the fields' texts. */
function loggedTaskArgs(args: Partial<Record<keyof TaskArgs, unknown>>): Record<string, unknown> {
  const { subagentType, description, items, answerFields, taskId } = args;
  return {
    subagentType: typeof subagentType === 'string' ? descriptionLine(subagentType).slice(0, 80) : null,
    form: description !== undefined ? 'single' : items !== undefined ? 'list' : null,
    items: Array.isArray(items) ? items.length : null,
    answerFields: Array.isArray(answerFields) ? answerFields.length : null,
    taskId: typeof taskId === 'number' ? taskId : null,
  };
}

/**
 * `task` as the registry holds it (deep-agents/design-task.md KD-4): its schema, description and log rule. Its
 * calls never run one by one — the tool step checks all `task` calls of an answer together and opens one tracker
 * through `Delegations` — so `execute` is never reached.
 */
export function createTaskTool(): InCommitAgentTool<TaskArgs> {
  return {
    name: TASK_TOOL,
    description: describeTask({ listDelegation: true, taskList: true, startable: [] }),
    argsSchema: TaskArgsSchema,
    mode: 'in_commit',
    loggedArgs: loggedTaskArgs,
    async execute({ caller, callId }) {
      throw new Error(`task call ${callId} of agent ${caller.agentId} runs through the tool step, never alone`);
    },
  };
}

/** A `task` call the step checked: its record and its parsed arguments. */
export interface TaskCall {
  readonly call: CallState;
  readonly args: TaskArgs;
}

/** How a sent `task` call closes: its ending, the full result to store, and the task of the list it completes. */
export interface DelegationClosing {
  readonly call: CallState;
  readonly ending: CallEnding;
  readonly stored: StoredToolResult | null;
  readonly completedTask: number | null;
}

/** What the tool step asks of `task` (KD-4, KD-5, KD-8). */
export interface Delegations {
  /** Checks the `task` calls of one answer together, outside any transaction. */
  decide(caller: ToolCaller, calls: readonly TaskCall[]): Promise<DelegationDecision>;
  /**
   * In the step's commit: the subagents' sessions with their assignments, one tracker of all their tasks, the
   * `tool_sent` of each accepted call with its task ids, and the named task of the list `in_progress` with the
   * subagent as its owner. The step then ends with `wait`.
   */
  open(input: {
    readonly tx: RuntimeTx;
    readonly effects: StepEffects;
    readonly caller: ToolCaller;
    readonly accepted: readonly AcceptedDelegation[];
    readonly logger: Logger;
  }): Promise<void>;
  /** The endings of the sent `task` calls once their tracker has finished, read outside any transaction. */
  closings(
    ctx: { readonly taskId: string; readonly ownerId: string; readonly logger: Logger },
    calls: readonly CallState[],
  ): Promise<DelegationClosing[]>;
  /** In the step's commit: the call's `tool_result`, its stored result and its task of the list `completed`. */
  close(tx: RuntimeTx, agentId: string, closing: DelegationClosing): Promise<HistoryEntry | undefined>;
}

export interface DelegationsDeps {
  /** The deep agent's history and task list are read from it before the commit. */
  readonly database: Database;
  /** The outcomes of the tracker's tasks (`Runtime.trackers.list`). */
  readonly trackers: Pick<Runtime['trackers'], 'list'>;
  /** The threshold of a stored result, as for an MCP result (tool-result-reading R-5). */
  readonly resultSettings: () => Promise<ToolResultSettingsRow>;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
}

function deepAgentOf(caller: ToolCaller): DeepAgentSnapshot {
  if (caller.snapshot.kind !== 'deep_agent') {
    throw new Error(`Agent ${caller.agentId} calls task without a deep agent's snapshot`);
  }
  return caller.snapshot;
}

/** The brief of a deep agent `start_deep_agent` started: its first entry; `null` for any other task. */
async function briefOf(reader: StoreReader, agentId: string): Promise<DeepAgentBrief | null> {
  const [first] = await history.through(reader, agentId, 1);
  if (first?.kind !== 'task') return null;
  try {
    const parsed = DeepAgentBriefSchema.safeParse(JSON.parse(first.content.text));
    return parsed.success ? parsed.data : null;
  } catch {
    // A task written as text, not as a brief: the deep agent was started without one.
    return null;
  }
}

/** The rule of an answer with fields (KD-7). */
function answerRule(fields: readonly AnswerField[]): string {
  return [
    'Answer with one JSON object and nothing else. Its fields, each a non-empty string:',
    ...fields.map((field) => `- ${field.name}: ${descriptionLine(field.description)}`),
  ].join('\n');
}

/**
 * The one `task` entry of a subagent (C3): the brief of the deep agent's start, then the description or the
 * instruction with the item, then the rule of the answer when fields are named.
 */
function assignmentOf(brief: DeepAgentBrief | null, body: string, fields: readonly AnswerField[]): string {
  const briefLines =
    brief === null
      ? []
      : [
          [
            `Question: ${brief.question}`,
            ...(brief.boundaries === '' ? [] : [`Boundaries: ${brief.boundaries}`]),
            ...(brief.result === '' ? [] : [`Result: ${brief.result}`]),
          ].join('\n'),
        ];
  return [...briefLines, body, ...(fields.length === 0 ? [] : [answerRule(fields)])].join('\n\n');
}

/** The subagents of an accepted call: the session description and the assignment body of each. */
function partsOf(accepted: AcceptedDelegation): { description: string; body: string }[] {
  const { form } = accepted;
  if (form.kind === 'single') return [{ description: form.description, body: form.description }];
  return form.items.map((item) => ({ description: item, body: `${form.instruction}\n\nItem: ${item}` }));
}

/** The report of a completed agent task: `{ report }`. */
const ReportSchema = z.object({ report: z.string() });

function reportOf(task: TrackerTask): string {
  return ReportSchema.parse(task.result).report;
}

/** A tracker task's end as the row and the result name it; a task revived since is not finished — cancelled. */
function endOf(task: TrackerTask): TableRow['status'] {
  if (task.status === 'completed') return 'completed';
  return task.status === 'failed' ? 'failed' : 'cancelled';
}

function failureText(task: TrackerTask): string {
  return endOf(task) === 'failed' ? `The subagent failed: ${task.failure?.reason ?? 'unknown'}.` : 'The task was cancelled.';
}

/** The line about the task of the list a call names (Contract «Инструмент `task`»). */
function listTaskLine(listTask: number, completed: boolean): string {
  return completed ? `Task ${listTask} completed` : `Task ${listTask} is still in_progress`;
}

function withLine(text: string, line: string | null): string {
  return line === null ? text : `${text}\n\n${line}`;
}

export function createDelegations(deps: DelegationsDeps): Delegations {
  const { database, trackers, resultSettings, maxDepth } = deps;

  /** The ending of a single call: the answer, a long one stored as an MCP result is; a failure or a cancel as an error. */
  function singleEnding(
    call: CallState,
    task: TrackerTask,
    settings: ToolResultSettingsRow,
    listLine: string | null,
  ): Pick<DelegationClosing, 'ending' | 'stored'> {
    const childTaskId = task.taskId;
    if (endOf(task) !== 'completed') {
      return {
        ending: { outcome: ToolOutcomeSchema.enum.tool_error, resultText: withLine(failureText(task), listLine), childTaskId },
        stored: null,
      };
    }
    const report = reportOf(task);
    if (report.length <= settings.storeFromChars) {
      return { ending: { outcome: 'success', resultText: withLine(report, listLine), childTaskId }, stored: null };
    }
    const text = wrapperText({ callId: call.callId, text: report, previewChars: settings.previewChars });
    return {
      ending: { outcome: 'success', resultText: withLine(text, listLine), childTaskId },
      stored: { value: report, text: report },
    };
  }

  /** The ending of a list call: the table, the full one stored when it is cut (KD-5). */
  function listEnding(
    call: CallState,
    args: TaskArgs,
    tasks: readonly TrackerTask[],
    listLine: string | null,
  ): Pick<DelegationClosing, 'ending' | 'stored'> {
    const items = args.items ?? [];
    const rows: TableRow[] = tasks.map((task, index) => ({
      item: items[index] ?? '',
      status: endOf(task),
      answer: endOf(task) === 'completed' ? reportOf(task) : null,
      reason: endOf(task) === 'failed' ? (task.failure?.reason ?? 'unknown') : null,
    }));
    const table = resultTable({
      rows,
      answerFields: (args.answerFields ?? []).map((field) => field.name),
      callId: call.callId,
      maxChars: TASK_TABLE_MAX_CHARS,
    });
    return {
      ending: { outcome: 'success', resultText: withLine(table.text, listLine) },
      stored: table.cut ? { value: table.full, text: table.full } : null,
    };
  }

  /** The tracker that holds the call's tasks, which must have finished. */
  function trackerOf(all: readonly Tracker[], call: CallState, agentId: string): Tracker {
    const first = call.delegation?.taskIds[0];
    const tracker = all.find((candidate) => candidate.tasks.some((task) => task.taskId === first));
    if (tracker?.status !== 'finished') {
      throw new Error(`task call ${call.callId} of agent ${agentId} has no finished tracker`);
    }
    return tracker;
  }

  return {
    async decide(caller, calls) {
      const deepAgent = deepAgentOf(caller);
      const definition = snapshotDefinition(deepAgent);
      const [singleRuns, tasks] = await Promise.all([
        history.singleTaskRuns(database, caller.agentId),
        definition.taskList ? sessionTasks.read(database, caller.agentId) : Promise.resolve(null),
      ]);
      const delegationCalls: DelegationCall[] = calls.map(({ call, args }) => ({ callId: call.callId, args }));
      return decideDelegations({
        calls: delegationCalls,
        team: delegationTeam(deepAgent),
        singleRuns,
        tasks,
        childTooDeep: caller.depth + 1 > maxDepth,
      });
    },

    async open({ tx, effects, caller, accepted, logger }) {
      const deepAgent = deepAgentOf(caller);
      const brief = await briefOf(tx, caller.agentId);
      const children = accepted.flatMap((delegation) =>
        partsOf(delegation).map(({ description, body }) => {
          const snapshot = subagentSnapshot(deepAgent, delegation.subagent);
          if (snapshot === null) throw new Error(`Subagent ${delegation.subagent} left the team of ${caller.agentId}`);
          const input: SessionInput = {
            snapshot,
            prompt: assignmentOf(brief, body, delegation.answerFields),
            description,
            ...(delegation.answerFields.length === 0 ? {} : { answerFields: [...delegation.answerFields] }),
          };
          return { delegation, input };
        }),
      );
      const { trackerId, taskIds } = await effects.openTracker(
        children.map(({ input }) => ({ type: AGENT_TASK_TYPE, input })),
      );
      for (const [index, { delegation, input }] of children.entries()) {
        const taskId = taskIds[index];
        if (taskId === undefined) throw new Error(`Tracker ${trackerId} gave no task for subagent ${index}`);
        await sessions.ensureSession(
          tx,
          { taskId, ownerId: caller.ownerId, parentId: caller.agentId, rootId: caller.rootId },
          input,
        );
        logger.info('task delegation started', {
          agentId: caller.agentId,
          rootId: caller.rootId,
          ownerId: caller.ownerId,
          callId: delegation.callId,
          trackerId,
          taskId,
          subagent: delegation.subagent,
          version: input.snapshot.origin.version,
          listTask: delegation.listTask,
        });
      }

      let next = 0;
      const startedAt = new Date().toISOString();
      for (const delegation of accepted) {
        const count = partsOf(delegation).length;
        const callTasks = taskIds.slice(next, next + count);
        next += count;
        await history.append(tx, caller.agentId, [
          {
            kind: 'tool_sent',
            content: {
              callId: delegation.callId,
              startedAt,
              taskIds: callTasks,
              ...(delegation.listTask === null ? {} : { taskId: delegation.listTask }),
            },
          },
        ]);
        if (delegation.listTask !== null) {
          await changeListTask(tx, caller.agentId, delegation.listTask, {
            status: 'in_progress',
            owner: delegation.subagent,
          });
        }
      }
    },

    async closings(ctx, calls) {
      const [all, settings] = await Promise.all([trackers.list(ctx.taskId, ctx.ownerId), resultSettings()]);
      return calls.map((call) => {
        const tracker = trackerOf(all, call, ctx.taskId);
        const taskIds = call.delegation?.taskIds ?? [];
        const tasks = taskIds.map((taskId) => {
          const task = tracker.tasks.find((candidate) => candidate.taskId === taskId);
          if (task === undefined) throw new Error(`Tracker ${tracker.trackerId} lost task ${taskId}`);
          return task;
        });
        const args = TaskArgsSchema.parse(call.args);
        const listTask = call.delegation?.listTask ?? null;
        const allCompleted = tasks.every((task) => endOf(task) === 'completed');
        const listLine = listTask === null ? null : listTaskLine(listTask, allCompleted);
        const single = tasks.length === 1 && args.description !== undefined;
        const { ending, stored } = single
          ? singleEnding(call, tasks[0] as TrackerTask, settings, listLine)
          : listEnding(call, args, tasks, listLine);
        for (const task of tasks) {
          ctx.logger.info('task delegation finished', {
            agentId: ctx.taskId,
            ownerId: ctx.ownerId,
            callId: call.callId,
            trackerId: tracker.trackerId,
            taskId: task.taskId,
            subagent: args.subagentType,
            status: endOf(task),
            reason: task.failure?.reason ?? null,
            listTask,
          });
        }
        return { call, ending, stored, completedTask: listTask !== null && allCompleted ? listTask : null };
      });
    },

    async close(tx, agentId, { call, ending, stored, completedTask }) {
      const closed = await callRecords.close(tx, agentId, call, ending);
      if (closed === undefined) return undefined;
      if (stored !== null) await toolResults.insert(tx, { taskId: agentId, callId: call.callId, ...stored });
      if (completedTask !== null) await changeListTask(tx, agentId, completedTask, { status: 'completed' });
      return closed;
    },
  };
}

/**
 * Changes the task of the list a `task` call names by the list's own rules (KD-8; design-task-list.md KD-3): only
 * the deep agent's steps write its list, and the call was checked against it, so a refusal here is a defect.
 */
async function changeListTask(
  tx: RuntimeTx,
  agentId: string,
  taskId: number,
  change: { readonly status: 'in_progress' | 'completed'; readonly owner?: string },
): Promise<void> {
  const state = await sessionTasks.read(tx, agentId);
  const decision = decideTaskChange(state, { tool: 'update', args: { taskId, ...change } });
  if (decision.kind === 'refused') {
    throw new Error(`Task ${taskId} of agent ${agentId} cannot become ${change.status}: ${decision.text}`);
  }
  await sessionTasks.write(tx, agentId, decision);
}
