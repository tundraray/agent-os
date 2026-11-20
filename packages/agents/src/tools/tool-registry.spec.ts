import { createLogger } from '@agent-os/common';
import { CHAT_BUILTIN_KEY, type RunOrigin } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import { z } from 'zod';

import type { AgentSnapshot, RunSnapshot, WorkflowSnapshot } from '../start/snapshot.js';
import { executorSnapshot } from '../start/snapshot-definition.js';
import { createLibraryDouble } from '../testing.js';
import type { AgentTool } from './tool.js';
import { createToolRegistry } from './tool-registry.js';

// design-runtime.md KD-6, Invariant 4, UC-E6, AC-18.4 (rule): the root's tools — `start_workflow` and
// `draft_record` — go to a session without a parent only; a child agent, an executor and a coordinator get
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
    executor: null,
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

const COORDINATOR: WorkflowSnapshot = {
  kind: 'workflow',
  name: 'Ресерч',
  origin: origin({ kind: 'workflow', name: 'Ресерч' }),
  content: {
    coordinator: { rules: '', model: MODEL, maxTurns: 10 },
    executors: [
      {
        name: 'searcher',
        role: 'Searches',
        prompt: 'Search.',
        servers: [],
        model: MODEL,
        maxTurns: 5,
        maxRuns: 2,
        tools: [],
        source: null,
      },
    ],
    finalExecutor: null,
    selfLearning: false,
  },
};

const EXECUTOR = executorSnapshot(COORDINATOR, 'searcher');
if (EXECUTOR === null) throw new Error('the coordinator has the executor searcher');

describe('the root alone gets the root tools', () => {
  it.each<[string, RunSnapshot, boolean, readonly string[]]>([
    [
      "a conversation's root",
      agentSnapshot(CHAT_BUILTIN_KEY),
      true,
      ['start_agent', 'list_agents', 'start_workflow', 'draft_record', 'run_code'],
    ],
    ['a child agent', agentSnapshot(null), false, ['start_agent', 'list_agents', 'run_code']],
    ['an executor', EXECUTOR, false, ['run_code']],
    ['a coordinator', COORDINATOR, false, ['start_agent', 'message_agent', 'run_code']],
  ])('%s', async (_, snapshot, root, expected) => {
    const registry = createToolRegistry({
      builtins: ['start_agent', 'message_agent', 'list_agents', 'stop_agent'].map((name) => stubTool(name)),
      runCode: stubTool('run_code'),
      database: emptyDatabase(),
      access: { tools: async () => ({ kind: 'allowed', allows: () => true }) },
      library: createLibraryDouble(),
      logger: SILENT,
    });
    registry.register(stubTool('start_workflow', true));
    registry.register(stubTool('draft_record', true));

    const tools = await registry.sessionTools({ snapshot, ownerId: OWNER, agentId: 'agent-1', root });

    expect(tools.map((tool) => tool.name)).toEqual(expected);
  });
});
