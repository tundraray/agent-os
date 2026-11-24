// design-access.md KD-5, KD-6, DC-3, DC-4, AC-22.11: an agent whose model or tool call the gate refuses starts no
// call and fails with the verdict's reason, with no pause; the refusal is audited once, a disabled owner never.
// The model, the MCP server and the database are doubles: the database answers every query with no rows, as for
// an agent with an empty history.
import type { Logger } from '@agent-os/common';
import {
  CodeCallsRepository,
  MemoriesRepository,
  McpAccountsRepository,
  McpServersRepository,
  MessagesRepository,
  ConversationsRepository,
  ConversationTasksRepository,
  SettingsRepository,
  ToolResultsRepository,
  type Database,
  Db,
} from '@agent-os/db';
import {
  type ModelPrice,
  type StepContext,
  type StepResult,
  systemClock,
} from '@agent-os/runtime';
import type { AgentVersion } from '@agent-os/contracts';
import { z } from 'zod';

import type {
  AccessDeniedEntry,
  AuditRecord,
  ModelVerdict,
} from './access-gate';
import type { CallState } from './history/call-state';
import { ChatAgent } from './agent/chat-agent';
import { ModelClient } from './model/model-client';
import { CallRecords } from './store/call-records';
import { History } from './store/history';
import type { RunStart } from './start/run-definition';
import { type AgentTaskInput, type Session, Sessions } from './store/sessions';
import {
  createAccessGateDouble,
  createLibraryDouble,
  createProviderRegistryDouble,
  createScriptedModel,
} from './testing';
import type { AgentTool } from './tools/tool';
import { createTaskListTools } from './tools/system/task-list-tools';
import { ToolRegistry } from './tools/tool-registry';
import { ToolRunner } from './tools/tool-runner';

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
      property === 'then'
        ? (resolve: (rows: unknown[]) => void) => resolve([])
        : query,
    apply: () => query,
  });
  return query as Database;
}

/** The built-in tool the agent's version names; the test's double stands for it. */
const LOOKUP = 'list_agents';

const VERSION: AgentVersion = {
  id: '00000000-0000-4000-8000-000000000003',
  agentId: '00000000-0000-4000-8000-000000000001',
  number: 1,
  kind: 'agent',
  content: {
    prompt: 'Help.',
    servers: [],
    model: MODEL,
    maxTurns: 10,
    agents: [],
    tools: [LOOKUP],
    taskList: false,
  },
};

const INPUT: AgentTaskInput = {};

const RUN: RunStart = {
  version: VERSION,
  name: 'helper',
  subagent: null,
  model: MODEL,
};

const SESSION: Session = {
  taskId: AGENT,
  parentId: null,
  ownerId: OWNER,
  versionId: VERSION.id,
  name: RUN.name,
  origin: {
    recordId: VERSION.agentId,
    kind: 'agent',
    version: 1,
    name: 'helper',
    author: { id: '00000000-0000-4000-8000-000000000002', name: 'Аня' },
    builtinKey: null,
    subagent: null,
  },
  firstRun: true,
  description: 'Look up',
  model: MODEL,
  startCallId: null,
  forkedThroughSeq: null,
  turns: 0,
  interrupted: false,
  closed: false,
  lastInputTokens: 50_000,
  createdAt: new Date(0),
};

const OPEN_CALL: CallState = {
  callId: 'call-1',
  answerSeq: 2,
  position: 0,
  tool: LOOKUP,
  server: null,
  args: {},
  state: 'requested',
  sentAt: null,
  delegation: null,
  attempts: 0,
  result: null,
};

function stepContext(logger: Logger): StepContext {
  return {
    taskId: AGENT,
    rootId: AGENT,
    parentId: null,
    ownerId: OWNER,
    depth: 0,
    type: 'chat',
    input: INPUT,
    stepNo: 3,
    resumedAfterLoss: false,
    messages: [],
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
  const db = new Db(emptyDatabase());
  const model = createScriptedModel();
  model.script({ agent: RUN.name }, [], {
    thereafter: { text: 'answer' },
  });
  const audits: AuditRecord[] = [];
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
  const audit = async (entry: AuditRecord) => {
    audits.push(entry);
  };
  const sessionRows = new ConversationsRepository(db);
  const messageRows = new MessagesRepository(db);
  const history = new History(messageRows);
  const stores = {
    sessions: new Sessions(sessionRows),
    sessionRows,
    history,
    messageRows,
    callRecords: new CallRecords(history, new CodeCallsRepository(db)),
    toolResultRows: new ToolResultsRepository(db),
    sessionTaskRows: new ConversationTasksRepository(db),
    // The chat has no memory: its block reads neither.
    memoryRows: new MemoriesRepository(db),
    settingsRows: new SettingsRepository(db),
  };
  const registry = new ToolRegistry(
    new McpServersRepository(db),
    new McpAccountsRepository(db),
    access,
  );
  const runCode = { ...lookup, name: 'run_code' };
  registry.useCodeRun(runCode, () => runCode);
  [lookup, ...createTaskListTools({ ...stores, logger })].forEach((tool) =>
    registry.register(tool),
  );
  const runner = new ToolRunner(
    stores.callRecords,
    {
      callTool: async () => {
        toolRuns += 1;
        return { kind: 'failure', reason: 'connection_lost' } as const;
      },
    },
    { credentialsFor: async () => ({ kind: 'server_gone' }) as const },
    access,
    audit,
    { mcpCallTimeoutMs: 1000 },
    {
      read: async () => ({
        key: 'tool_result_settings',
        value: {
          storeFromChars: 50_000,
          previewChars: 2_000,
          readMaxTokens: 25_000,
        },
        updatedAt: null,
        updatedBy: null,
      }),
    },
    (text) => text,
  );
  runner.useStartChild(() => async () => ({ agentId: 'child-1' }));
  const modelClient = new ModelClient(
    model.turnClient,
    { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
    { maxOutputTokens: 100 },
    logger,
    access,
    createProviderRegistryDouble({ anthropic: 'ready' }),
    audit,
    systemClock,
    { check: async () => 'allowed' as const },
  );
  const notCalled = async (): Promise<never> => {
    throw new Error('not called by these specs');
  };
  // The specs run a conversation's root: the chat, which delegates no call and has no memory.
  const ctx = stepContext(logger);
  const agent = new ChatAgent(
    {
      ...stores,
      registry,
      runner,
      access,
      audit,
      modelClient,
      tasks: { get: notCalled, listTree: async () => [] },
      inbox: { listPending: async () => [] },
      compactAtTokens: 100_000,
      library: createLibraryDouble(),
      logger,
    },
    { task: ctx, input: INPUT, run: RUN, training: false },
  );
  return {
    ctx,
    agent,
    audits,
    /** Model calls and tool runs that started. */
    started: () => model.calls.length + toolRuns,
  };
}

type RefusedAgent = ReturnType<typeof refusedAgent>;

const QUOTA: Refusal = {
  kind: 'refused',
  reason: 'quota_exhausted',
  spentUsd: 20,
  quotaUsd: 20,
  month: '2026-11',
};

function deniedModel(reason: string): AccessDeniedEntry {
  return {
    kind: 'access_denied',
    actor: OWNER,
    objectType: 'model',
    objectId: MODEL,
    outcome: 'rejected',
    reason,
  };
}

/** The history of a session with no entry yet. */
const NO_HISTORY = { entries: [], lastSeq: 0 };

const modelStep = ({ agent, ctx }: RefusedAgent) =>
  agent.modelStep(ctx, SESSION, NO_HISTORY);

describe("an agent whose model or tool call is refused by the gate ends `failed` with the verdict's reason; the audit hook runs once, never for `owner_disabled`", () => {
  it.each<
    [
      string,
      Refusal,
      (agent: RefusedAgent) => Promise<StepResult>,
      readonly AccessDeniedEntry[],
    ]
  >([
    [
      'the model step of a disabled owner',
      { kind: 'refused', reason: 'owner_disabled' },
      modelStep,
      [],
    ],
    [
      'the model step on a spent quota',
      QUOTA,
      modelStep,
      [deniedModel('quota_exhausted')],
    ],
    [
      'the compaction step on a spent quota',
      QUOTA,
      ({ agent, ctx }) => agent.compactionStep(ctx, SESSION, NO_HISTORY),
      [deniedModel('quota_exhausted')],
    ],
    [
      'the tool step of a disabled owner',
      { kind: 'refused', reason: 'owner_disabled' },
      ({ agent, ctx }) =>
        agent.toolStep(ctx, SESSION, [OPEN_CALL], [OPEN_CALL]),
      [],
    ],
  ])('%s', async (_, refusal, act, audits) => {
    const agent = refusedAgent(refusal);

    const result = await act(agent);

    expect(
      result.outcome === 'fail'
        ? { outcome: result.outcome, reason: result.reason }
        : result,
    ).toEqual({
      outcome: 'fail',
      reason: refusal.reason,
    });
    expect(agent.started()).toBe(0);
    expect(agent.audits).toEqual(audits);
  });
});
