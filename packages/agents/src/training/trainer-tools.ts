import type { Logger } from '@agent-os/common';
import {
  DocumentRefSchema,
  MEMORY_TOOLS,
  roundJudged,
  TEST_RUN_TOOLS,
  TRAINER_TOOLS,
} from '@agent-os/contracts';
import type {
  AgentTrainingRow,
  AgentsRepository,
  ConversationsRepository,
  DocumentsRepository,
  MemoriesRepository,
  SettingsRepository,
  TrainingsRepository,
} from '@agent-os/db';
import type { TaskControl } from '@agent-os/runtime';
import { z } from 'zod';

import type { AccessGate } from '../access-gate';
import { reportOf } from '../agent/deliver';
import { taskQuestion } from '../deep/brief';
import type { RecordLibrary } from '../start/record-library';
import type { History } from '../store/history';
import { maskValue, pageOf, wrapperText } from '../tools/large-result';
import type {
  OutsideAgentTool,
  ToolCaller,
  ToolRunResult,
} from '../tools/tool';
import type { ToolRegistry } from '../tools/tool-registry';
import { readToolResultSettings } from '../tools/tool-result-settings';
import { reportDocument } from './trainer-step';
import {
  pastTaskIds,
  reAsksOf,
  type TrainingBase,
  trainingBase,
} from './training-reads';

const [
  PAST_TASKS_TOOL,
  READ_PAST_TASK_TOOL,
  READ_PAST_DOCUMENT_TOOL,
  AGENT_MEMORY_TOOL,
  AGENT_DEFINITION_TOOL,
] = TRAINER_TOOLS;
const TEST_RESULTS_TOOL = TEST_RUN_TOOLS[5];

/** The most past tasks the list shows, newest first (design-training.md, «Инструменты тренера»). */
const PAST_TASKS_MAX = 20;
/** The most characters of a task's first phrase in the list. */
const FIRST_PHRASE_MAX = 200;

const NO_SUCH_TASK = 'There is no such past task.';

export interface TrainerToolsDeps {
  readonly trainingRows: Pick<TrainingsRepository, 'find'>;
  readonly agentRows: Pick<
    AgentsRepository,
    'findVersion' | 'trainingVersions'
  >;
  readonly conversationRows: Pick<
    ConversationsRepository,
    'pastTasks' | 'serversCalled' | 'find' | 'findMany'
  >;
  readonly memoryRows: Pick<MemoriesRepository, 'listLive'>;
  readonly documentRows: Pick<
    DocumentsRepository,
    'listRun' | 'findInRun' | 'latestReport'
  >;
  readonly settingsRows: Pick<SettingsRepository, 'read'>;
  readonly history: Pick<History, 'after' | 'taskText'>;
  readonly tasks: Pick<TaskControl, 'get' | 'listTree'>;
  readonly access: Pick<AccessGate, 'tools'>;
  readonly registry: Pick<ToolRegistry, 'declaredMcpTools'>;
  /** The skills of the trained version for `agent_definition` (agent-guidance DC-5). */
  readonly library: Pick<RecordLibrary, 'skills'>;
  readonly maskSecrets: (text: string) => string;
  readonly logger: Logger;
}

/**
 * A memory call not of the agent's scope — the employee's, or a missing or invalid one: its record's description
 * and text never reach the trainer (KD-2).
 */
function hidesRecord(call: {
  readonly tool: string;
  readonly server: string | null;
  readonly args: unknown;
}): boolean {
  const { args } = call;
  return (
    call.server === null &&
    MEMORY_TOOLS.some((tool) => tool === call.tool) &&
    !(
      typeof args === 'object' &&
      args !== null &&
      'scope' in args &&
      args.scope === 'agent'
    )
  );
}

/** The first phrase of a task text, on one line and cut. */
function firstPhrase(text: string): string {
  const [first = ''] = taskQuestion(text)
    .trim()
    .split(/(?<=[.!?])\s|\n/u);
  return first.slice(0, FIRST_PHRASE_MAX);
}

const ConversationArgsSchema = z.object({
  conversation: z
    .uuid()
    .describe(
      'The id of a past task (its conversation), as past_tasks lists it',
    ),
});

const DocumentArgsSchema = ConversationArgsSchema.extend({
  document: DocumentRefSchema.shape.id.describe(
    'The number of the document, as read_past_task lists it',
  ),
  offset: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      'The first line to read, 1 = the first line. A page names the offset of the next one.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'At most this many lines. Without it, as many lines as one page holds.',
    ),
});

const NoArgsSchema = z.object({});

/**
 * The trainer's reads (design-training.md, KD-1, KD-2, «Инструменты тренера») of the trained agent. The agent is the training row's of the caller's tree; a past task given by the model is
 * read only when it is one of that agent's past tasks by the start's rule. Reads give a stored result: the full
 * one under the call's id, a wrapper to the model when it is long; everything is masked; no employee is named.
 */
export function createTrainerTools(deps: TrainerToolsDeps) {
  const logger = deps.logger.child({ service: 'agents.trainer-tools' });
  const { history, tasks, conversationRows, documentRows, maskSecrets } = deps;

  /** A read's answer: the value masked and stored whole, the model's text a wrapper past the stored threshold. */
  async function storedAnswer(
    callId: string,
    value: unknown,
  ): Promise<ToolRunResult> {
    const masked = maskValue(value, maskSecrets);
    const text = JSON.stringify(masked, null, 1);
    const settings = await readToolResultSettings(deps.settingsRows);
    return {
      kind: 'done',
      outcome: 'success',
      text:
        text.length <= settings.storeFromChars
          ? text
          : wrapperText({ callId, text, previewChars: settings.previewChars }),
      stored: { value: masked, text },
    };
  }

  /** A read tool: its call gets the training and is logged with its ids and the length of the answer. */
  function readTool<Args extends Record<string, unknown>>(tool: {
    readonly name: string;
    readonly description: string;
    readonly argsSchema: z.ZodType<Args>;
    run(
      args: Args,
      base: TrainingBase,
      input: { readonly caller: ToolCaller; readonly callId: string },
    ): Promise<ToolRunResult>;
  }): OutsideAgentTool<Args> {
    return {
      name: tool.name,
      description: tool.description,
      argsSchema: tool.argsSchema,
      mode: 'outside',
      async execute({ args, caller, callId }) {
        const base = await trainingBase(deps, caller);
        if ('kind' in base) return base;
        const { training } = base;
        const result = await tool.run(args, base, { caller, callId });
        logger.info('trainer read', {
          tool: tool.name,
          trainingId: training.id,
          agentId: training.agentId,
          callId,
          conversation:
            typeof args.conversation === 'string' ? args.conversation : null,
          outcome: result.kind === 'done' ? result.outcome : result.reason,
          chars:
            result.kind === 'done'
              ? (result.stored?.text ?? result.text).length
              : 0,
        });
        return result;
      },
    };
  }

  /** Whether the conversation is a past task of the training's agent for the training's starter. */
  async function isPastTask(
    caller: ToolCaller,
    training: AgentTrainingRow,
    conversation: string,
  ): Promise<boolean> {
    const found = await pastTaskIds(
      deps,
      caller.ownerId,
      training.agentId,
      conversation,
    );
    return found.length > 0;
  }

  /** A past task's run row and task, read by its own owner: the trainer reads every employee's runs (KD-2). */
  async function pastRun(conversation: string) {
    const row = await conversationRows.find(conversation);
    if (row === undefined)
      throw new Error(`Past task ${conversation} has no conversation`);
    const task = await tasks.get(conversation, row.ownerId);
    return { row, task };
  }

  /**
   * The tool calls of one run with their outcomes; a memory call of the employee's scope without its record, and one
   * refused by the check without the rejected description and text (its refusal text is fixed and echoes neither).
   */
  async function callsOf(runId: string) {
    const entries = await history.after(runId, 0);
    return entries.flatMap((entry) => {
      if (entry.kind !== 'tool_result') return [];
      const { tool, server, args, outcome, refusalReason, text } =
        entry.content;
      const hidden = hidesRecord({ tool, server, args });
      const rejected =
        refusalReason === 'looks_like_secret' ||
        refusalReason === 'looks_like_instruction';
      return [
        {
          tool,
          server,
          args: hidden
            ? { scope: 'user' }
            : rejected
              ? { scope: 'agent' }
              : args,
          outcome,
          refusalReason,
          text: hidden ? null : text,
        },
      ];
    });
  }

  /** A run and the runs under it, each with its name and its tool calls. */
  async function runsOf(runId: string, rootId: string, ownerId: string) {
    const tree = await tasks.listTree(rootId, ownerId);
    const runIds = [runId];
    for (const candidate of tree) {
      if (candidate.parentId !== null && runIds.includes(candidate.parentId))
        runIds.push(candidate.taskId);
    }
    const runRows = await conversationRows.findMany(runIds);
    return Promise.all(
      runIds.map(async (id) => ({
        name: runRows.find((run) => run.id === id)?.name ?? null,
        calls: await callsOf(id),
      })),
    );
  }

  const pastTasks = readTool({
    name: PAST_TASKS_TOOL,
    description: `List up to ${PAST_TASKS_MAX} past tasks of the trained agent, newest first: the conversation id, the date, the first phrase of the task, how it ended and how many times the employee asked again after it.`,
    argsSchema: NoArgsSchema,
    async run(_args, { training }, { caller, callId }) {
      const ids = (
        await pastTaskIds(deps, caller.ownerId, training.agentId)
      ).slice(0, PAST_TASKS_MAX);
      const listed = await Promise.all(
        ids.map(async (id) => {
          const { row, task } = await pastRun(id);
          return {
            conversation: id,
            date: task.createdAt.toISOString(),
            task: firstPhrase(await history.taskText(id)),
            status: task.status,
            reAsks:
              row.parentId === null
                ? 0
                : (await reAsksOf(history, row.parentId, id)).length,
          };
        }),
      );
      return storedAnswer(callId, listed);
    },
  });

  const readPastTask = readTool({
    name: READ_PAST_TASK_TOOL,
    description:
      "Read one past task of the trained agent by its conversation id: the task, the tool calls of the deep agent and its subagents with their outcomes, the short answer, the employee's messages after the report and the documents of its notepad.",
    argsSchema: ConversationArgsSchema,
    async run({ conversation }, { training }, { caller, callId }) {
      if (!(await isPastTask(caller, training, conversation)))
        return {
          kind: 'refused',
          reason: 'invalid_arguments',
          text: NO_SUCH_TASK,
        };
      const { row, task } = await pastRun(conversation);
      const value = {
        conversation,
        task: await history.taskText(conversation),
        status: task.status,
        answer:
          task.status === 'completed'
            ? reportOf(task.result)
            : (task.failure?.message ?? null),
        runs: await runsOf(conversation, task.rootId, row.ownerId),
        reAsks:
          row.parentId === null
            ? []
            : await reAsksOf(history, row.parentId, conversation),
        documents: (await documentRows.listRun(conversation)).map(
          (document) => ({
            id: document.id,
            title: document.title,
            description: document.description,
            report: document.report,
            chars: document.chars,
          }),
        ),
      };
      return storedAnswer(callId, value);
    },
  });

  const readPastDocument = readTool({
    name: READ_PAST_DOCUMENT_TOOL,
    description:
      'Read a page of a document of a past task by the conversation id and the document number: lines from offset (1 = first), at most limit lines and one page of a bounded size. The report of the run is its document marked report.',
    argsSchema: DocumentArgsSchema,
    async run(args, { training }, { caller }) {
      const document = (await isPastTask(caller, training, args.conversation))
        ? await documentRows.findInRun(args.conversation, args.document)
        : undefined;
      if (document === undefined)
        return {
          kind: 'refused',
          reason: 'invalid_arguments',
          text: 'There is no such document of a past task.',
        };
      const settings = await readToolResultSettings(deps.settingsRows);
      const page = pageOf(maskSecrets(document.text), {
        offset: args.offset,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        maxTokens: settings.readMaxTokens,
      });
      if (page.kind === 'past_end')
        return {
          kind: 'refused',
          reason: 'invalid_arguments',
          text: `Offset ${args.offset} is past the last line ${page.total} of document ${args.document}.`,
        };
      return {
        kind: 'done',
        outcome: 'success',
        text: `Document ${document.id}: ${maskSecrets(document.title)}\n${page.text}`,
      };
    },
  });

  const agentMemory = readTool({
    name: AGENT_MEMORY_TOOL,
    description:
      "Read the trained agent's memory records of scope agent: description, text and when each changed, most recently changed first.",
    argsSchema: NoArgsSchema,
    async run(_args, { training }, { callId }) {
      // The query by the agent's id holds agent-scope records only: a record of an employee has no agent. The
      // trainer sees only live records (memory-hygiene, Data Model rule 4).
      const records = await deps.memoryRows.listLive({
        agentId: training.agentId,
      });
      if (records.length === 0)
        return {
          kind: 'done',
          outcome: 'empty',
          text: 'The agent has no memory records.',
        };
      return storedAnswer(
        callId,
        records.map((record) => ({
          description: record.description,
          text: record.lastText,
          updatedAt: record.changedAt.toISOString(),
        })),
      );
    },
  });

  const agentDefinition = readTool({
    name: AGENT_DEFINITION_TOOL,
    description:
      'Read the version of the agent you work on — the base version of a training, the latest version of a test run: its number, its content (prompts, subagents, servers, scripts, flags), the name, description and text of each of its skills, and the tools of its servers, with whether each only reads.',
    argsSchema: NoArgsSchema,
    async run(_args, { number, content }, { caller, callId }) {
      const servers = [
        ...new Set([
          ...content.servers,
          ...content.subagents.flatMap((subagent) => subagent.servers),
        ]),
      ];
      const tools = await deps.registry.declaredMcpTools(servers);
      // The version's skills as its runs read them: undeleted, whoever trains it (KD-6, AC-08.1).
      const skills = await deps.library.skills(caller.ownerId, content.skills);
      return storedAnswer(callId, {
        version: number,
        content,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          text: skill.content.text,
        })),
        tools: tools.map((tool) => ({
          name: tool.name,
          readOnly: tool.mcp.readOnly,
          description: tool.description,
        })),
      });
    },
  });

  const testResults = readTool({
    name: TEST_RESULTS_TOOL,
    description:
      'Read the tests of the last judged round: each task and expected result, the verdict and its reason, and the runs of its test with their tool calls and outcomes (recorded — a changing call that was not sent) and its report.',
    argsSchema: NoArgsSchema,
    async run(_args, { training }, { caller, callId }) {
      let round = Math.max(
        0,
        ...training.tests.map((test) => test.rounds.length),
      );
      while (round > 0 && !roundJudged(training.tests, round)) round -= 1;
      const tests = await Promise.all(
        training.tests.map(async ({ task, expected, rounds }, index) => {
          const slot = rounds[round - 1];
          return {
            number: index + 1,
            task,
            expected,
            verdict: slot?.verdict ?? null,
            reason: slot?.reason ?? null,
            runs:
              slot?.runId == null
                ? []
                : await runsOf(slot.runId, caller.rootId, caller.ownerId),
            report:
              slot?.runId == null
                ? null
                : ((await reportDocument(deps, slot.runId)) ?? null),
          };
        }),
      );
      return storedAnswer(callId, tests);
    },
  });

  return [
    testResults,
    pastTasks,
    readPastTask,
    readPastDocument,
    agentMemory,
    agentDefinition,
  ];
}
