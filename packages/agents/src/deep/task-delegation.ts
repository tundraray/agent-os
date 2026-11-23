import type { Logger } from '@agent-os/common';
import {
  AGENT_TASK_TYPE,
  type ChildFinishedPayload,
  RecordNameSchema,
  ToolOutcomeSchema,
  type SettingsValue,
} from '@agent-os/contracts';
import type {
  MessagesRepository,
  ConversationTasksRepository,
  ToolResultsRepository,
  StoredToolResult,
} from '@agent-os/db';
import type { StepEffects } from '@agent-os/runtime';
import { z } from 'zod';

import { descriptionLine } from '../chat-listing';
import type { CallState } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import { type RunStart, runDefinition } from '../start/run-definition';
import type { CallEnding, CallRecords } from '../store/call-records';
import type { History } from '../store/history';
import {
  type AgentTaskInput,
  AnswerFieldSchema,
  type Sessions,
  type SessionStart,
} from '../store/sessions';
import { wrapperText } from '../tools/large-result';
import { decideTaskChange } from '../tools/system/task-list-rules';
import type {
  InCommitAgentTool,
  ToolCaller,
  ToolDeclaration,
} from '../tools/tool';
import { type DeepAgentBrief, DeepAgentBriefSchema } from './brief';
import {
  type DeepAgentVersion,
  delegationTeam,
  subagentStart,
  TASK_TOOL,
} from './deep-definition';
import {
  type AcceptedDelegation,
  type AnswerField,
  type DelegationCall,
  type DelegationDecision,
  decideDelegations,
  resultTable,
  type SubagentEnd,
  subagentEnd,
  TASK_TABLE_MAX_CHARS,
  type TaskArgs,
} from './delegation-rules';

/** Field limits of Contract «Инструмент `task`». */
const ASSIGNMENT_MAX_LENGTH = 8_000;
const ITEM_MAX_LENGTH = 2_000;
const ANSWER_FIELDS_MAX = 10;

/** The arguments of `task` with every field; a session gets the fields its flags allow (`taskArgsSchema`). */
const TaskArgsSchema = z.strictObject({
  subagentType: RecordNameSchema.describe(
    'The name of the subagent, as the list below gives it; any other name starts general-purpose under that name',
  ),
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
    .describe(
      'What to do for each item of items; give it with items instead of description',
    ),
  items: z
    .array(z.string().trim().min(1).max(ITEM_MAX_LENGTH))
    .optional()
    .describe(
      'The items, one subagent each; the result is a table with a row per item',
    ),
  answerFields: z
    .array(AnswerFieldSchema)
    .max(ANSWER_FIELDS_MAX)
    .optional()
    .describe(
      'The fields of the answer: the subagent then answers with one JSON object of them',
    ),
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
function taskArgsSchema(
  declaration: Pick<ToolDeclaration, 'listDelegation' | 'taskList'>,
): z.ZodType<TaskArgs> {
  return TaskArgsSchema.omit({
    ...(declaration.listDelegation ? {} : { instruction: true, items: true }),
    ...(declaration.taskList ? {} : { taskId: true }),
  });
}

/** The description of `task` (Contract «Инструмент `task`»): the forms, then the subagents with their limits. */
function describeTask(
  declaration: Pick<
    ToolDeclaration,
    'listDelegation' | 'taskList' | 'startable'
  >,
): string {
  return [
    'Give work to a subagent. It works in the background on its own and sees only what you give it; the call’s result is its last message.',
    'You are resumed when every subagent of your answer has finished, or at once when one fails or is stopped: then a subagent still running reports later as a message. Nothing is to be polled.',
    declaration.listDelegation
      ? 'Give description for one assignment, or instruction with items to run one subagent per item: that call’s result is a table with a row per item.'
      : 'Give description: the whole assignment.',
    'With answerFields the subagent answers with one JSON object of those fields.',
    ...(declaration.taskList
      ? [
          'With taskId the work is for that task of your list: it becomes in_progress with the subagent as its owner, and completed when every subagent of the call has completed.',
        ]
      : []),
    'Subagents you may call (subagentType):',
    ...(declaration.startable ?? []).map((line) => `- ${line}`),
  ].join('\n');
}

/** The fields of a call the log may name: never the assignment, the instruction, the items or the fields' texts. */
function loggedTaskArgs(
  args: Partial<Record<keyof TaskArgs, unknown>>,
): Record<string, unknown> {
  const { subagentType, description, items, answerFields, taskId } = args;
  return {
    subagentType:
      typeof subagentType === 'string'
        ? descriptionLine(subagentType).slice(0, 80)
        : null,
    form:
      description !== undefined
        ? 'single'
        : items !== undefined
          ? 'list'
          : null,
    items: Array.isArray(items) ? items.length : null,
    answerFields: Array.isArray(answerFields) ? answerFields.length : null,
    taskId: typeof taskId === 'number' ? taskId : null,
  };
}

/**
 * `task` as the registry holds it (deep-agents/design-task.md KD-4): its schema, description and log rule; a deep
 * agent sees it by its declaration — its subagents, and the fields its flags allow (DC-6). Its
 * calls never run one by one — the tool step hands all `task` calls of an answer to `DeepAgent`, which checks
 * them together and starts their subagents as awaited children through `Delegations` — so `execute` is never
 * reached.
 */
export function createTaskTool(): InCommitAgentTool<TaskArgs> {
  return {
    name: TASK_TOOL,
    description: describeTask({
      listDelegation: true,
      taskList: true,
      startable: [],
    }),
    argsSchema: TaskArgsSchema,
    mode: 'in_commit',
    describe: (declaration) => ({
      description: describeTask(declaration),
      argsSchema: taskArgsSchema(declaration),
    }),
    loggedArgs: loggedTaskArgs,
    async execute({ caller, callId }) {
      throw new Error(
        `task call ${callId} of agent ${caller.agentId} runs through the tool step, never alone`,
      );
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

/** What `DeepAgent` asks of `task` (KD-4, KD-5, KD-8). */
export interface Delegations {
  /** Checks the `task` calls of one answer together, outside any transaction. */
  decide(
    caller: ToolCaller,
    calls: readonly TaskCall[],
  ): Promise<DelegationDecision>;
  /**
   * In the step's commit: each subagent an awaited child with its session and assignment, the `tool_sent` of
   * each accepted call with its task ids, and the named task of the list `in_progress` with the subagent as its
   * owner. The step then ends with `wait`, and the runtime wakes the agent by the rule of awaited children.
   */
  open(input: {
    readonly effects: StepEffects;
    readonly caller: ToolCaller;
    readonly accepted: readonly AcceptedDelegation[];
    readonly logger: Logger;
  }): Promise<void>;
  /**
   * The endings of the sent `task` calls in the step after their start, outside any transaction: each subagent
   * by its `child_finished` of this step (`finished`, by child task id), one without it as still running
   * (data-model/design-runtime.md, Contract «Инструмент `task`»).
   */
  closings(
    ctx: {
      readonly taskId: string;
      readonly ownerId: string;
      readonly logger: Logger;
    },
    calls: readonly CallState[],
    finished: ReadonlyMap<string, ChildFinishedPayload>,
  ): Promise<DelegationClosing[]>;
  /** In the step's commit: the call's `tool_result`, its stored result and its task of the list `completed`. */
  close(
    agentId: string,
    closing: DelegationClosing,
  ): Promise<HistoryEntry | undefined>;
}

export interface DelegationsDeps {
  /** The session of each subagent, the `tool_sent` and the closing of each call, and the deep agent's task list. */
  readonly sessions: Sessions;
  readonly history: History;
  readonly messageRows: MessagesRepository;
  readonly callRecords: CallRecords;
  readonly sessionTaskRows: ConversationTasksRepository;
  readonly toolResultRows: ToolResultsRepository;
  /** The threshold of a stored result, as for an MCP result (tool-result-reading R-5). */
  readonly resultSettings: () => Promise<SettingsValue<'tool_result_settings'>>;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
}

/** The deep agent's run of the caller: `task` is a deep agent's tool. */
function deepAgentOf(caller: ToolCaller): {
  readonly run: RunStart;
  readonly version: DeepAgentVersion;
} {
  const { run } = caller;
  if (run.version.kind !== 'deep_agent' || run.subagent !== null) {
    throw new Error(
      `Agent ${caller.agentId} calls task without a deep agent's version`,
    );
  }
  return { run, version: run.version };
}

/** The brief of a deep agent `start_deep_agent` started: its first entry; `null` for any other task. */
async function briefOf(
  history: History,
  agentId: string,
): Promise<DeepAgentBrief | null> {
  const [first] = await history.through(agentId, 1);
  if (first?.kind !== 'task') return null;
  try {
    const parsed = DeepAgentBriefSchema.safeParse(
      JSON.parse(first.content.text),
    );
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
    ...fields.map(
      (field) => `- ${field.name}: ${descriptionLine(field.description)}`,
    ),
  ].join('\n');
}

/**
 * The one `task` entry of a subagent (C3): the brief of the deep agent's start, then the description or the
 * instruction with the item, then the rule of the answer when fields are named.
 */
function assignmentOf(
  brief: DeepAgentBrief | null,
  body: string,
  fields: readonly AnswerField[],
): string {
  const briefLines =
    brief === null
      ? []
      : [
          [
            `Question: ${brief.question}`,
            ...(brief.boundaries === ''
              ? []
              : [`Boundaries: ${brief.boundaries}`]),
            ...(brief.result === '' ? [] : [`Result: ${brief.result}`]),
          ].join('\n'),
        ];
  return [
    ...briefLines,
    body,
    ...(fields.length === 0 ? [] : [answerRule(fields)]),
  ].join('\n\n');
}

/** The subagents of an accepted call: the session description and the assignment body of each. */
function partsOf(
  accepted: AcceptedDelegation,
): { description: string; body: string }[] {
  const { form } = accepted;
  if (form.kind === 'single')
    return [{ description: form.description, body: form.description }];
  return form.items.map((item) => ({
    description: item,
    body: `${form.instruction}\n\nItem: ${item}`,
  }));
}

/** The line about the task of the list a call names (Contract «Инструмент `task`»). */
function listTaskLine(listTask: number, completed: boolean): string {
  return completed
    ? `Task ${listTask} completed`
    : `Task ${listTask} is still in_progress`;
}

function withLine(text: string, line: string | null): string {
  return line === null ? text : `${text}\n\n${line}`;
}

export function createDelegations(deps: DelegationsDeps): Delegations {
  const { resultSettings, maxDepth } = deps;
  const {
    sessions,
    history,
    messageRows,
    callRecords,
    sessionTaskRows,
    toolResultRows,
  } = deps;

  /** The ending of a single call: the answer, a long one stored as an MCP result is; any other end as an error. */
  function singleEnding(
    call: CallState,
    childTaskId: string,
    end: SubagentEnd,
    settings: SettingsValue<'tool_result_settings'>,
    listLine: string | null,
  ): Pick<DelegationClosing, 'ending' | 'stored'> {
    if (end.answer === null) {
      return {
        ending: {
          outcome: ToolOutcomeSchema.enum.tool_error,
          resultText: withLine(end.line ?? '', listLine),
          childTaskId,
        },
        stored: null,
      };
    }
    const report = end.answer;
    if (report.length <= settings.storeFromChars) {
      return {
        ending: {
          outcome: 'success',
          resultText: withLine(report, listLine),
          childTaskId,
        },
        stored: null,
      };
    }
    const text = wrapperText({
      callId: call.callId,
      text: report,
      previewChars: settings.previewChars,
    });
    return {
      ending: {
        outcome: 'success',
        resultText: withLine(text, listLine),
        childTaskId,
      },
      stored: { value: report, text: report },
    };
  }

  /** The ending of a list call: the table, the full one stored when it is cut (KD-5). */
  function listEnding(
    call: CallState,
    args: TaskArgs,
    ends: readonly SubagentEnd[],
    listLine: string | null,
  ): Pick<DelegationClosing, 'ending' | 'stored'> {
    const items = args.items ?? [];
    const table = resultTable({
      rows: ends.map((end, index) => ({ ...end, item: items[index] ?? '' })),
      answerFields: (args.answerFields ?? []).map((field) => field.name),
      callId: call.callId,
      maxChars: TASK_TABLE_MAX_CHARS,
    });
    return {
      ending: {
        outcome: 'success',
        resultText: withLine(table.text, listLine),
      },
      stored: table.cut ? { value: table.full, text: table.full } : null,
    };
  }

  return {
    async decide(caller, calls) {
      const deepAgent = deepAgentOf(caller);
      const definition = runDefinition(deepAgent.run);
      const [runs, tasks] = await Promise.all([
        messageRows.singleTaskRuns(caller.agentId, TASK_TOOL),
        definition.taskList
          ? sessionTaskRows.read(caller.agentId)
          : Promise.resolve(null),
      ]);
      const delegationCalls: DelegationCall[] = calls.map(({ call, args }) => ({
        callId: call.callId,
        args,
      }));
      return decideDelegations({
        calls: delegationCalls,
        team: delegationTeam(deepAgent.version.content),
        singleRuns: new Map(runs.map((row) => [row.subagent, row.runs])),
        tasks,
        childTooDeep: caller.depth + 1 > maxDepth,
      });
    },

    async open({ effects, caller, accepted, logger }) {
      const deepAgent = deepAgentOf(caller);
      const brief = await briefOf(history, caller.agentId);
      const children = accepted.flatMap((delegation) =>
        partsOf(delegation).map(({ description, body }) => {
          const run = subagentStart(deepAgent.run, delegation);
          if (run === null)
            throw new Error(
              `Subagent ${delegation.subagent} left the team of ${caller.agentId}`,
            );
          const input: AgentTaskInput =
            delegation.answerFields.length === 0
              ? {}
              : { answerFields: [...delegation.answerFields] };
          const start: SessionStart = {
            run,
            prompt: assignmentOf(brief, body, delegation.answerFields),
            description,
            startCallId: delegation.callId,
          };
          return { delegation, input, start };
        }),
      );
      const taskIds: string[] = [];
      for (const { delegation, input, start } of children) {
        const taskId = await effects.spawn({
          type: AGENT_TASK_TYPE,
          input,
          awaited: true,
        });
        taskIds.push(taskId);
        // A subagent's kind adds nothing to a new session, so the store makes it directly, in the commit that
        // spawns its task (KD-8).
        await sessions.ensureSession(
          {
            taskId,
            ownerId: caller.ownerId,
            parentId: caller.agentId,
          },
          start,
        );
        logger.info('task delegation started', {
          agentId: caller.agentId,
          rootId: caller.rootId,
          ownerId: caller.ownerId,
          callId: delegation.callId,
          taskId,
          subagent: delegation.subagent,
          name: delegation.name,
          versionId: start.run.version.id,
          version: deepAgent.version.number,
          model: start.run.model,
          listTask: delegation.listTask,
        });
      }

      let next = 0;
      const startedAt = new Date().toISOString();
      for (const delegation of accepted) {
        const count = partsOf(delegation).length;
        const callTasks = taskIds.slice(next, next + count);
        next += count;
        await history.append(caller.agentId, [
          {
            kind: 'tool_sent',
            content: {
              callId: delegation.callId,
              startedAt,
              taskIds: callTasks,
              ...(delegation.listTask === null
                ? {}
                : { taskId: delegation.listTask }),
            },
          },
        ]);
        if (delegation.listTask !== null) {
          await changeListTask(
            sessionTaskRows,
            caller.agentId,
            delegation.listTask,
            {
              status: 'in_progress',
              owner: delegation.name,
            },
          );
        }
      }
    },

    async closings(ctx, calls, finished) {
      const settings = await resultSettings();
      return calls.map((call) => {
        const taskIds = call.delegation?.taskIds ?? [];
        const ends = taskIds.map((taskId) => subagentEnd(finished.get(taskId)));
        const args = TaskArgsSchema.parse(call.args);
        const listTask = call.delegation?.listTask ?? null;
        const allCompleted = ends.every((end) => end.status === 'completed');
        const listLine =
          listTask === null ? null : listTaskLine(listTask, allCompleted);
        const [childTaskId] = taskIds;
        const [end] = ends;
        const single =
          args.description !== undefined &&
          ends.length === 1 &&
          childTaskId !== undefined &&
          end !== undefined;
        const { ending, stored } = single
          ? singleEnding(call, childTaskId, end, settings, listLine)
          : listEnding(call, args, ends, listLine);
        for (const [index, taskId] of taskIds.entries()) {
          ctx.logger.info('task delegation closed', {
            agentId: ctx.taskId,
            ownerId: ctx.ownerId,
            callId: call.callId,
            taskId,
            subagent: args.subagentType,
            status: ends[index]?.status ?? null,
            reason: finished.get(taskId)?.failure?.reason ?? null,
            listTask,
          });
        }
        return {
          call,
          ending,
          stored,
          completedTask: listTask !== null && allCompleted ? listTask : null,
        };
      });
    },

    async close(agentId, { call, ending, stored, completedTask }) {
      const closed = await callRecords.close(agentId, call, ending);
      if (closed === undefined) return undefined;
      if (stored !== null)
        await toolResultRows.insert({
          taskId: agentId,
          callId: call.callId,
          ...stored,
        });
      if (completedTask !== null)
        await changeListTask(sessionTaskRows, agentId, completedTask, {
          status: 'completed',
        });
      return closed;
    },
  };
}

/**
 * Changes the task of the list a `task` call names by the list's own rules (KD-8; design-task-list.md KD-3): only
 * the deep agent's steps write its list, and the call was checked against it, so a refusal here is a defect.
 */
async function changeListTask(
  sessionTaskRows: ConversationTasksRepository,
  agentId: string,
  taskId: number,
  change: {
    readonly status: 'in_progress' | 'completed';
    readonly owner?: string;
  },
): Promise<void> {
  const state = await sessionTaskRows.read(agentId);
  const decision = decideTaskChange(state, {
    tool: 'update',
    args: { taskId, ...change },
  });
  if (decision.kind === 'refused') {
    throw new Error(
      `Task ${taskId} of agent ${agentId} cannot become ${change.status}: ${decision.text}`,
    );
  }
  await sessionTaskRows.write(agentId, decision);
}
