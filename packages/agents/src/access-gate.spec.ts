// design-access.md KD-5, KD-6, DC-3, DC-4, AC-22.11: an agent whose model or tool call the gate refuses starts no
// call and fails with the verdict's reason, with no pause; the refusal is audited once, a disabled owner never.
// The model, the MCP server and the database are doubles: the database answers every query with no rows, as for
// an agent with an empty history.
import type { Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import type { ModelPrice, StepContext, StepResult } from '@agent-os/runtime';
import { z } from 'zod';

import type { AccessDeniedEntry, ModelVerdict } from './access-gate.js';
import type { KnowledgeVectorStore } from './knowledge/vector-store.js';
import { createModelClient } from './model/model-client.js';
import type { AgentSnapshot } from './start/snapshot.js';
import { createCompactionStep } from './step/compaction-step.js';
import { createModelStep } from './step/model-step.js';
import { createToolStep } from './step/tool-step.js';
import type { Session, SessionInput } from './store/sessions.repository.js';
import type { ToolCallRow } from './store/tool-calls.repository.js';
import {
  createAccessGateDouble,
  createLibraryDouble,
  createProviderRegistryDouble,
  createScriptedModel,
} from './testing.js';
import type { AgentTool } from './tools/tool.js';
import { createToolRegistry } from './tools/tool-registry.js';
import { createToolRunner } from './tools/tool-runner.js';

const OWNER = 'employee-1';
const AGENT = 'agent-1';
const MODEL = 'anthropic/claude-haiku-5-5';

const PRICE: ModelPrice = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.1,
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

/** The built-in tool the agent's snapshot names; the test's double stands for it. */
const LOOKUP = 'list_agents';

const SNAPSHOT: AgentSnapshot = {
  kind: 'agent',
  name: 'helper',
  origin: {
    recordId: '00000000-0000-4000-8000-000000000001',
    kind: 'agent',
    version: 1,
    name: 'helper',
    author: { id: '00000000-0000-4000-8000-000000000002', name: 'Аня' },
    builtinKey: null,
    executor: null,
  },
  content: { prompt: 'Help.', servers: [], model: MODEL, maxTurns: 10, agents: [], tools: [LOOKUP] },
  agents: [],
};

const INPUT: SessionInput = { snapshot: SNAPSHOT, prompt: 'Look it up', description: 'Look up' };

const SESSION: Session = {
  taskId: AGENT,
  parentId: null,
  ownerId: OWNER,
  name: SNAPSHOT.name,
  origin: SNAPSHOT.origin,
  firstRun: true,
  description: 'Look up',
  model: MODEL,
  prompt: 'Look it up',
  forkedFromTaskId: null,
  forkedThroughSeq: null,
  turns: 0,
  interrupted: false,
  closed: false,
  lastInputTokens: 50_000,
  createdAt: new Date(0),
};

const OPEN_CALL: ToolCallRow = {
  taskId: AGENT,
  callId: 'call-1',
  answerSeq: 2,
  position: 0,
  tool: LOOKUP,
  server: null,
  args: {},
  state: 'requested',
  outcome: null,
  refusalReason: null,
  refusalDetail: null,
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
    input: INPUT,
    stepNo: 3,
    resumedAfterLoss: false,
    messages: [],
    decision: null,
    signal: new AbortController().signal,
    logger,
    guard: async () => {
      throw new Error('a refused call writes nothing outside the commit');
    },
  };
}

/** The gate's answer in a row: a refusal of the model, or a disabled owner. */
type Refusal = Extract<ModelVerdict, { readonly kind: 'refused' }>;

/** Every step of an agent over the gate double that answers `refusal`, with counting doubles. */
function refusedAgent(refusal: Refusal) {
  const logger = loggerDouble();
  const database = emptyDatabase();
  const model = createScriptedModel();
  model.script({ agent: SNAPSHOT.name }, [], { thereafter: { text: 'answer' } });
  const audits: AccessDeniedEntry[] = [];
  let toolRuns = 0;
  const lookup: AgentTool = {
    name: LOOKUP,
    description: 'Looks a thing up',
    argsSchema: z.object({}),
    mode: 'outside',
    execute: async () => {
      toolRuns += 1;
      return { kind: 'done', outcome: 'success', text: 'found' };
    },
  };
  const access = createAccessGateDouble({
    prices: { [MODEL]: PRICE },
    ...(refusal.reason === 'owner_disabled'
      ? { refusedOwners: [OWNER] }
      : { refusedModels: { [MODEL]: refusal } }),
  });
  const audit = async (entry: AccessDeniedEntry) => {
    audits.push(entry);
  };
  const registry = createToolRegistry({
    builtins: [lookup],
    runCode: { ...lookup, name: 'run_code' },
    database,
    access,
    library: createLibraryDouble(),
    logger,
  });
  const runner = createToolRunner({
    client: {
      callTool: async () => {
        toolRuns += 1;
        return { kind: 'failure', reason: 'connection_lost' } as const;
      },
    },
    accounts: { credentialsFor: async () => ({ kind: 'server_gone' }) as const },
    access,
    audit,
    callTimeoutMs: 1000,
    toolResultMaxBytes: 1024,
    startChildFor: () => async () => ({ agentId: 'child-1' }),
  });
  const modelClient = createModelClient({
    turnClient: model.turnClient,
    ledger: { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
    config: { maxOutputTokens: 100 },
    logger,
    access,
    providers: createProviderRegistryDouble({ anthropic: 'ready' }),
    audit,
  });
  // The agent's snapshot does not learn: the knowledge block never reaches the store.
  const notCalled = async (): Promise<never> => {
    throw new Error('the vector store is not called for a session that does not learn');
  };
  const vectorStore: KnowledgeVectorStore = {
    upsert: notCalled,
    delete: notCalled,
    query: notCalled,
    list: notCalled,
  };
  return {
    ctx: stepContext(logger),
    modelStep: createModelStep({
      database,
      registry,
      modelClient,
      audit,
      tasks: { listTree: async () => [] },
      inbox: { listPending: async () => [] },
      vectorStore,
    }),
    compactionStep: createCompactionStep({ database, registry, modelClient, audit, vectorStore }),
    toolStep: createToolStep({ registry, runner, access, audit }),
    audits,
    /** Model calls and tool runs that started. */
    started: () => model.calls.length + toolRuns,
  };
}

type RefusedAgent = ReturnType<typeof refusedAgent>;

const QUOTA: Refusal = { kind: 'refused', reason: 'quota_exhausted', spentUsd: 20, quotaUsd: 20, month: '2026-11' };

function deniedModel(reason: string): AccessDeniedEntry {
  return { kind: 'access_denied', actor: OWNER, objectType: 'model', objectId: MODEL, outcome: 'rejected', reason };
}

const modelStep = (agent: RefusedAgent) => agent.modelStep(agent.ctx, SESSION);

describe("an agent whose model or tool call is refused by the gate ends `failed` with the verdict's reason; the audit hook runs once, never for `owner_disabled`", () => {
  it.each<[string, Refusal, (agent: RefusedAgent) => Promise<StepResult>, readonly AccessDeniedEntry[]]>([
    ['the model step of a disabled owner', { kind: 'refused', reason: 'owner_disabled' }, modelStep, []],
    ['the model step on a spent quota', QUOTA, modelStep, [deniedModel('quota_exhausted')]],
    [
      'the compaction step on a spent quota',
      QUOTA,
      (agent) => agent.compactionStep(agent.ctx, SESSION),
      [deniedModel('quota_exhausted')],
    ],
    [
      'the tool step of a disabled owner',
      { kind: 'refused', reason: 'owner_disabled' },
      (agent) => agent.toolStep(agent.ctx, SESSION, [OPEN_CALL]),
      [],
    ],
  ])('%s', async (_, refusal, act, audits) => {
    const agent = refusedAgent(refusal);

    const result = await act(agent);

    expect(result.outcome === 'fail' ? { outcome: result.outcome, reason: result.reason } : result).toEqual({
      outcome: 'fail',
      reason: refusal.reason,
    });
    expect(agent.started()).toBe(0);
    expect(agent.audits).toEqual(audits);
  });
});
