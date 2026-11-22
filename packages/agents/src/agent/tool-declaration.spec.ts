import { createLogger } from '@agent-os/common';
import { CHAT_BUILTIN_KEY, type RunOrigin } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { StepContext } from '@agent-os/runtime';
import { z } from 'zod';

import { DeepAgent, type DeepAgentDeps } from '../deep/deep-agent';
import { subagentSnapshot } from '../deep/deep-definition';
import { createTaskTool } from '../deep/task-delegation';
import type { AgentSnapshot, DeepAgentSnapshot, RunSnapshot } from '../start/snapshot';
import { createLibraryDouble } from '../testing';
import { TASK_LIST_TOOLS } from '../tools/system/task-list-tools';
import type { AgentTool } from '../tools/tool';
import { createToolRegistry } from '../tools/tool-registry';
import { Agent } from './agent';
import type { AgentDeps } from './agent-deps';
import type { BaseAgent } from './base-agent';
import { ChatAgent, type ChatAgentDeps } from './chat-agent';

// design-runtime.md KD-6, Invariant 4, UC-E6, AC-18.4 (rule): the root's tools — the built-in
// `start_deep_agent` and a tool `apps/api` registers — go to a session without a parent only; a child agent, a subagent and a deep agent get
// none of them. deep-agents design-task-list.md UC-5 (AC-16.1, DC-4): the four task tools follow the snapshot's
// `taskList` flag, except at the root, which keeps them with the flag off.
const OWNER = 'employee-1';
const MODEL = 'anthropic/claude-haiku-5-5';
const SILENT = createLogger({ sinks: [], secrets: [], minLevel: 'error' });
const CTX = { ownerId: OWNER, taskId: 'agent-1' } as StepContext;

/** A database whose every query resolves to no rows: the owner has no sessions yet. */
function emptyDatabase(): Database {
  const query: object = new Proxy(() => {}, {
    get: (_target, property) =>
      property === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : query,
    apply: () => query,
  });
  return query as Database;
}

// A declaration reads only the snapshot; the chat's listing also reads the library and the owner's sessions.
const DEPS = { database: emptyDatabase(), library: createLibraryDouble(), logger: SILENT };
const CHAT = new ChatAgent(DEPS as unknown as ChatAgentDeps);
const AGENT = new Agent(DEPS as unknown as AgentDeps);
const DEEP = new DeepAgent(DEPS as unknown as DeepAgentDeps);

function stubTool(name: string, rootOnly = false): AgentTool {
  return {
    name,
    description: `${name} stub`,
    argsSchema: z.object({}),
    mode: 'outside',
    ...(rootOnly ? { rootOnly } : {}),
    execute: async () => ({ kind: 'done', outcome: 'success', text: '' }),
  };
}

function origin(overrides: Partial<RunOrigin> = {}): RunOrigin {
  return {
    recordId: '00000000-0000-4000-8000-000000000001',
    kind: 'agent',
    version: 1,
    name: 'Помощник',
    author: null,
    builtinKey: null,
    subagent: null,
    ...overrides,
  };
}

function agentSnapshot(builtinKey: string | null, taskList: boolean): AgentSnapshot {
  return {
    kind: 'agent',
    name: 'Помощник',
    origin: origin({ builtinKey }),
    content: {
      prompt: 'Help.',
      servers: [],
      model: MODEL,
      maxTurns: 10,
      agents: [],
      tools: ['start_agent', 'list_agents'],
      taskList,
    },
    agents: [],
  };
}

const DEEP_AGENT: DeepAgentSnapshot = {
  kind: 'deep_agent',
  name: 'Ресерч',
  origin: origin({ kind: 'deep_agent', name: 'Ресерч' }),
  content: {
    prompt: 'Research.',
    servers: [],
    model: MODEL,
    maxTurns: 10,
    subagents: [
      {
        name: 'searcher',
        description: 'Searches',
        prompt: 'Search.',
        servers: [],
        model: MODEL,
        maxTurns: 5,
        maxRuns: 2,
        taskList: false,
      },
    ],
    finalSubagent: null,
    taskList: true,
    listDelegation: true,
    selfLearning: false,
  },
};

const SUBAGENT = subagentSnapshot(DEEP_AGENT, 'searcher');
if (SUBAGENT === null) throw new Error('the deep agent has the subagent searcher');

/** The tools of a model call: what the agent declares for its snapshot, answered by the library for the owner. */
async function toolsOf(agent: BaseAgent, snapshot: RunSnapshot) {
  return registryOfStubs().toolsFor(OWNER, await agent.offeredDeclaration(CTX, snapshot));
}

describe('the root alone gets the root tools; the task tools follow the flag, and the root always has them', () => {
  it.each<[string, BaseAgent, RunSnapshot, readonly string[]]>([
    [
      "a conversation's root with the task list off in its record",
      CHAT,
      agentSnapshot(CHAT_BUILTIN_KEY, false),
      ['start_agent', 'list_agents', ...TASK_LIST_TOOLS, 'start_deep_agent', 'list_records', 'run_code'],
    ],
    ['a child agent with the task list off', AGENT, agentSnapshot(null, false), ['start_agent', 'list_agents', 'run_code']],
    ['a subagent with the task list off', AGENT, SUBAGENT, ['run_code']],
    // deep-agents/design-task.md KD-6: a deep agent gives work only through task.
    ['a deep agent with the task list on', DEEP, DEEP_AGENT, ['task', ...TASK_LIST_TOOLS, 'run_code']],
  ])('%s', async (_, agent, snapshot, expected) => {
    const tools = await toolsOf(agent, snapshot);

    expect(tools.map((tool) => tool.name)).toEqual(expected);
  });
});

function registryOfStubs() {
  const registry = createToolRegistry({
    runCode: stubTool('run_code'),
    database: emptyDatabase(),
    access: { tools: async () => ({ kind: 'allowed', allows: () => true }) },
  });
  [
    ...['start_agent', 'message_agent', 'list_agents', 'stop_agent', ...TASK_LIST_TOOLS].map((name) => stubTool(name)),
    stubTool('start_deep_agent', true),
    createTaskTool(),
    stubTool('list_records', true),
  ].forEach((tool) => registry.register(tool));
  return registry;
}

// deep-agents/design-task.md AC-20.1, AC-20.2, AC-24.1, DC-6 — data of the snapshot: task lists the record's
// subagents and general-purpose with their limits; the list fields exist only with the list form on, taskId only
// with a task list, and any other key is refused.
describe("a deep agent's task follows its snapshot", () => {
  async function taskOf(content: Partial<DeepAgentSnapshot['content']>) {
    const snapshot: DeepAgentSnapshot = { ...DEEP_AGENT, content: { ...DEEP_AGENT.content, ...content } };
    const task = (await toolsOf(DEEP, snapshot)).find((tool) => tool.name === 'task');
    if (task?.kind !== 'system') throw new Error('the deep agent has no task');
    return task;
  }
  const LIST = { subagentType: 'searcher', instruction: 'Find', items: ['a'] };
  const LINKED = { subagentType: 'general-purpose', description: 'Do it', taskId: 1 };

  it('names the subagents of the record and general-purpose with their limits', async () => {
    const task = await taskOf({});

    expect(task.description.split('\n').slice(-3)).toEqual([
      'Subagents you may call (subagentType):',
      '- searcher (up to 2 runs): Searches',
      '- general-purpose (up to 20 runs): A subagent with the deep agent’s own model and tools: call it for a separate piece of work no other subagent fits.',
    ]);
  });

  it.each<[string, Partial<DeepAgentSnapshot['content']>, object, boolean]>([
    ['the list form on takes instruction and items', { listDelegation: true }, LIST, true],
    ['the list form off refuses them', { listDelegation: false }, LIST, false],
    ['a task list takes taskId', { taskList: true }, LINKED, true],
    ['no task list refuses taskId', { taskList: false }, LINKED, false],
    ['a key outside the schema is refused', {}, { subagentType: 'searcher', description: 'Do it', note: 'x' }, false],
  ])('%s', async (_, content, args, accepted) => {
    expect((await taskOf(content)).inputSchema.safeParse(args).success).toBe(accepted);
  });
});
