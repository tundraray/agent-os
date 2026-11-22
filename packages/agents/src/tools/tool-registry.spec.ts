import { createLogger } from '@agent-os/common';
import { CHAT_BUILTIN_KEY, type RunOrigin } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import { z } from 'zod';

import type { AgentSnapshot, DeepAgentSnapshot, RunSnapshot } from '../start/snapshot';
import { subagentSnapshot } from '../start/snapshot-definition';
import { createLibraryDouble } from '../testing';
import type { AgentTool } from './tool';
import { createToolRegistry, loggedArgsOf } from './tool-registry';

// design-runtime.md KD-6, Invariant 4, UC-E6, AC-18.4 (rule): the root's tools — the built-in
// `start_deep_agent` and a tool `apps/api` registers — go to a session without a parent only; a child agent, a subagent and a deep agent get
// none of them.
const OWNER = 'employee-1';
const MODEL = 'anthropic/claude-haiku-5-5';
const SILENT = createLogger({ sinks: [], secrets: [], minLevel: 'error' });

/** A database whose every query resolves to no rows: the owner has no sessions yet. */
function emptyDatabase(): Database {
  const query: object = new Proxy(() => {}, {
    get: (_target, property) =>
      property === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : query,
    apply: () => query,
  });
  return query as Database;
}

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

function agentSnapshot(builtinKey: string | null): AgentSnapshot {
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
      },
    ],
    finalSubagent: null,
    selfLearning: false,
  },
};

const SUBAGENT = subagentSnapshot(DEEP_AGENT, 'searcher');
if (SUBAGENT === null) throw new Error('the deep agent has the subagent searcher');

describe('the root alone gets the root tools', () => {
  it.each<[string, RunSnapshot, boolean, readonly string[]]>([
    [
      "a conversation's root",
      agentSnapshot(CHAT_BUILTIN_KEY),
      true,
      ['start_agent', 'list_agents', 'start_deep_agent', 'list_records', 'run_code'],
    ],
    ['a child agent', agentSnapshot(null), false, ['start_agent', 'list_agents', 'run_code']],
    ['a subagent', SUBAGENT, false, ['run_code']],
    ['a deep agent', DEEP_AGENT, false, ['start_agent', 'message_agent', 'task_list', 'run_code']],
  ])('%s', async (_, snapshot, root, expected) => {
    const registry = createToolRegistry({
      builtins: [
        ...['start_agent', 'message_agent', 'list_agents', 'stop_agent', 'task_list'].map((name) => stubTool(name)),
        stubTool('start_deep_agent', true),
      ],
      runCode: stubTool('run_code'),
      database: emptyDatabase(),
      access: { tools: async () => ({ kind: 'allowed', allows: () => true }) },
      library: createLibraryDouble(),
      logger: SILENT,
    });
    registry.register(stubTool('list_records', true));

    const tools = await registry.sessionTools({ snapshot, ownerId: OWNER, agentId: 'agent-1', root });

    expect(tools.map((tool) => tool.name)).toEqual(expected);
  });
});

// Security review: a call to a tool the session was not offered must not put its raw arguments in the log.
describe('the logged arguments of a tool the session was not offered', () => {
  const createRecord: AgentTool = { ...stubTool('create_record'), loggedArgs: () => ({ kind: 'agent' }) };
  const toolOf = (name: string) => (name === 'create_record' ? createRecord : undefined);
  const args = { kind: 'agent', prompt: 'the whole record' };

  it.each<[string, string, unknown]>([
    ['a registered tool keeps its own rule', 'create_record', { kind: 'agent' }],
    ['a name nobody registered gives the keys only', 'unknown_tool', { keys: ['kind', 'prompt'] }],
  ])('%s', (_, name, expected) => {
    expect(loggedArgsOf([], toolOf, { name, args })).toStrictEqual(expected);
  });
});
