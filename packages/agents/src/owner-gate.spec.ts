// design-identity.md DC-8, Invariant 6, KD-4: a disabled or unknown owner's agent starts no model or
// tool call and fails with `owner_disabled`. The model, the MCP server and the database are doubles:
// the database answers every query with no rows, as for an agent with an empty history.
import type { Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import type { StepContext, StepResult } from '@agent-os/runtime';
import { z } from 'zod';

import { createCatalog } from './definitions/catalog.js';
import type { AgentDefinition } from './definitions/definition.js';
import { createModelClient } from './model/model-client.js';
import { OwnerDisabledError, type OwnerGate } from './owner-gate.js';
import { createCompactionStep } from './step/compaction-step.js';
import { createModelStep } from './step/model-step.js';
import { createToolStep } from './step/tool-step.js';
import type { Session } from './store/sessions.repository.js';
import type { ToolCallRow } from './store/tool-calls.repository.js';
import { createScriptedModel } from './testing.js';
import type { AgentTool, ToolCaller } from './tools/tool.js';
import { createToolRegistry, type SessionTool } from './tools/tool-registry.js';
import { createToolRunner } from './tools/tool-runner.js';

const OWNER = 'disabled-employee';
const AGENT = 'agent-1';

const REFUSING_GATE: OwnerGate = {
  check: async (ownerId) => {
    throw new OwnerDisabledError(ownerId);
  },
};

function loggerDouble(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

/** A database whose every query resolves to no rows. */
function emptyDatabase(): Database {
  const query: object = new Proxy(() => {}, {
    get: (_target, property) =>
      property === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : query,
    apply: () => query,
  });
  return query as Database;
}

const DEFINITION: AgentDefinition = {
  name: 'helper',
  description: 'Looks things up.',
  prompt: 'Help.',
  tools: ['lookup'],
  mcpServers: [],
  agents: [],
  maxTurns: 10,
};

const SESSION: Session = {
  taskId: AGENT,
  ownerId: OWNER,
  definition: DEFINITION.name,
  description: 'Look up',
  model: 'anthropic/claude-haiku-5-5',
  prompt: 'Look it up',
  limits: null,
  forkedFromTaskId: null,
  forkedThroughSeq: null,
  turns: 0,
  interrupted: false,
  closed: false,
  lastInputTokens: 50_000,
  createdAt: new Date(0),
};

const CALLER: ToolCaller = { agentId: AGENT, ownerId: OWNER, rootId: AGENT, parentId: null, depth: 0 };

const MCP_TOOL: SessionTool = {
  kind: 'mcp',
  name: 'mcp__logs__search',
  description: 'Search log lines',
  inputSchema: { type: 'object' },
  mcp: {
    name: 'mcp__logs__search',
    server: 'logs',
    tool: 'search',
    description: 'Search log lines',
    inputSchema: { type: 'object' },
    readOnly: true,
    display: {},
  },
};

const OPEN_CALL: ToolCallRow = {
  taskId: AGENT,
  callId: 'call-1',
  answerSeq: 2,
  position: 0,
  tool: 'lookup',
  server: null,
  args: {},
  state: 'requested',
  outcome: null,
  refusalReason: null,
  resultText: null,
  childTaskId: null,
  startedAt: null,
  finishedAt: null,
  attempts: 0,
  output: null,
};

function stepContext(logger: Logger): StepContext {
  return {
    taskId: AGENT,
    rootId: AGENT,
    parentId: null,
    ownerId: OWNER,
    depth: 0,
    type: 'agent',
    input: {},
    stepNo: 3,
    resumedAfterLoss: false,
    messages: [],
    decision: null,
    signal: new AbortController().signal,
    logger,
    guard: async () => {
      throw new Error('a refused owner writes nothing outside the commit');
    },
  };
}

/** Every part of the package an agent's calls go through, over a refusing gate and counting doubles. */
function refusedAgent() {
  const logger = loggerDouble();
  const database = emptyDatabase();
  const model = createScriptedModel();
  model.script({ agent: DEFINITION.name }, [], { thereafter: { text: 'answer' } });
  const textCalls = model.completeText({ text: 'A title' }).calls;
  let toolRuns = 0;
  const lookup: AgentTool = {
    name: 'lookup',
    description: 'Looks a thing up',
    argsSchema: z.object({}),
    mode: 'outside',
    execute: async () => {
      toolRuns += 1;
      return { kind: 'done', outcome: 'success', text: 'found' };
    },
  };
  const client = {
    callTool: async () => {
      toolRuns += 1;
      return { kind: 'failure', reason: 'connection_lost' } as const;
    },
  };
  const accounts = {
    credentialsFor: async () =>
      ({
        kind: 'ready',
        url: 'http://localhost:4100/mcp',
        auth: { mode: 'shared', token: async () => 'token' },
        rejected: async () => {},
      }) as const,
  };
  const catalog = createCatalog();
  catalog.register(DEFINITION);
  const registry = createToolRegistry({
    builtins: [lookup],
    runCode: { ...lookup, name: 'run_code' },
    catalog,
    database,
    serverAllowed: () => false,
  });
  const runner = createToolRunner({
    client,
    accounts,
    serverAllowed: (ownerId, server) => ownerId === OWNER && server === 'logs',
    callTimeoutMs: 1000,
    toolResultMaxBytes: 1024,
    startChildFor: () => async () => ({ agentId: 'child-1' }),
    ownerGate: REFUSING_GATE,
  });
  const modelClient = createModelClient({
    turnClient: model.turnClient,
    ledger: { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
    config: { maxOutputTokens: 100, defaultModel: 'anthropic/claude-haiku-5-5' },
    logger,
    ownerGate: REFUSING_GATE,
  });
  const ctx = stepContext(logger);
  return {
    ctx,
    modelStep: createModelStep({
      database,
      catalog,
      registry,
      modelClient,
      tasks: { listTree: async () => [] },
      inbox: { listPending: async () => [] },
    }),
    compactionStep: createCompactionStep({ database, catalog, registry, modelClient }),
    toolStep: createToolStep({ catalog, registry, runner }),
    runner,
    modelClient,
    /** Model calls, `completeText` included, and tool runs that started. */
    started: () => model.calls.length + textCalls.length + toolRuns,
  };
}

type RefusedAgent = ReturnType<typeof refusedAgent>;

/** What a step returned, or what the call rejected with. */
async function endOf(act: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = (await act()) as StepResult;
    return result.outcome === 'fail' ? { outcome: result.outcome, reason: result.reason } : result;
  } catch (error) {
    return error instanceof OwnerDisabledError ? { rejected: error.code } : error;
  }
}

describe('OwnerGate', () => {
  it.each<[string, (agent: RefusedAgent) => Promise<unknown>, unknown]>([
    [
      'the model step',
      (agent) => agent.modelStep(agent.ctx, SESSION),
      { outcome: 'fail', reason: 'owner_disabled' },
    ],
    [
      'the compaction step',
      (agent) => agent.compactionStep(agent.ctx, SESSION),
      { outcome: 'fail', reason: 'owner_disabled' },
    ],
    [
      'the tool step',
      (agent) => agent.toolStep(agent.ctx, SESSION, [OPEN_CALL]),
      { outcome: 'fail', reason: 'owner_disabled' },
    ],
    [
      'a tool call from code',
      (agent) =>
        agent.runner.callFromCode(
          { name: MCP_TOOL.name, args: { query: 'error' } },
          {
            caller: CALLER,
            snapshot: [MCP_TOOL],
            runClass: 'read',
            agentToolNames: ['lookup'],
            callId: 'run-1',
            signal: new AbortController().signal,
            logger: loggerDouble(),
          },
        ),
      { rejected: 'OWNER_DISABLED' },
    ],
    [
      'completeText',
      (agent) =>
        agent.modelClient.completeText({
          ownerId: OWNER,
          system: 'Write a title.',
          prompt: 'Hi',
          maxOutputTokens: 64,
          signal: new AbortController().signal,
        }),
      { rejected: 'OWNER_DISABLED' },
    ],
  ])(
    'a refused owner starts no model call and no tool call, and the step ends failed with owner_disabled: %s',
    async (_name, act, expected) => {
      const agent = refusedAgent();

      const end = await endOf(() => act(agent));

      expect(end).toEqual(expected);
      expect(agent.started()).toBe(0);
    },
  );
});
