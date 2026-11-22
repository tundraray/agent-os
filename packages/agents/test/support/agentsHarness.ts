import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AgentHistoryEntry,
  type Agents,
  type AgentSessions,
  type AgentTurnMessage,
  type AgentTurnModelClient,
  type AgentView,
  type AuditRecord,
  createAgents,
  type EmbeddingVerdict,
  createMastraTurnClient,
  type InCommitAgentTool,
  parseAgentsConfig,
  type StartResolution,
  type TextDelta,
} from '@agent-os/agents';
import type { CodeRunner } from '@agent-os/code-runner';
import { createLogger, type LogRecord } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import { type AgentContent, CHAT_BUILTIN_KEY, type DeepAgentContent } from '@agent-os/contracts';
import {
  agentCodeCalls,
  agentModelProviders,
  agentRunTasks,
  createDatabase,
  type Database,
  runtimeEvents,
  runtimeInbox,
  runtimeModelCalls,
} from '@agent-os/db';
import {
  createFixtureFiles,
  type FixtureFiles,
  type FixtureProcess,
  type FixtureSource,
  startFixtureProcess,
} from '@agent-os/mcp-fixture';
import {
  type AccessGateDoubleOptions,
  createAccessGateDouble,
  createLibraryDouble,
  createScriptedEmbeddings,
  type LibraryDouble,
  type LibraryDoubleRecord,
  type ScriptedEmbeddings,
  type ScriptedModel,
} from '@agent-os/agents/testing';

export { toolCallRowsOf } from '@agent-os/agents/testing';
import {
  createRuntime,
  type ModelPrice,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
  type Task,
} from '@agent-os/runtime';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { databaseUrl } from './database-url';
import { registerFixtureServers, removeServer, runName } from './mcp-servers';

/**
 * Test assembly of the agents part (design-agents.md, Test Strategy): the package's own `createRuntime` and
 * `createAgents` over their own pool, without `apps/api`. Postgres, the runtime and every agents component
 * are real; the model is the scripted double under `ModelClient` (plan Notes 9), the library of agents and
 * deep agents is the `createLibraryDouble` of the test (a root starts from its `chat` record, a child from
 * the record its parent names) and MCP is the fixture
 * process over HTTP, registered in the registry under the run's names (`mcp-servers.ts`). A second
 * instance ("the restarted server") is a second harness over the same database, the same fixture files
 * and the same library double: it starts its own fixture process and points the run's registry rows at
 * it; both processes write the same call log. The model provider is the row {@link HARNESS_PROVIDER} in the
 * database, which the open harnesses of a test file keep and the last one deletes.
 */

/**
 * The model provider of every harness (model-providers design-core.md, Test Strategy): an `openai_compatible`
 * row without a key, so it is `ready`. Never `anthropic`: the tests run on the developer's database, whose
 * `anthropic` row may hold a real key.
 */
const HARNESS_PROVIDER = 'agents-harness';

/** The default chat model of the access gate double and the model of a test record: input 1, output 5 USD per million tokens. */
export const TEST_MODEL_DEFAULT = `${HARNESS_PROVIDER}/test-default`;
/** A second priced model a launch may name: input 3, output 15 USD per million tokens. */
export const TEST_MODEL_CHOSEN = `${HARNESS_PROVIDER}/test-chosen`;

/** The model catalogue of every harness: both models, rates exact in binary. */
const TEST_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  [TEST_MODEL_DEFAULT]: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.125,
  },
  [TEST_MODEL_CHOSEN]: {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheWriteUsdPerMTok: 3.75,
    cacheReadUsdPerMTok: 0.375,
  },
};

/** What the access gate double answers for embeddings until a test chooses a model: none is chosen. */
const NO_EMBEDDING_MODEL: EmbeddingVerdict = { kind: 'refused', reason: 'model_not_configured' };

/** An embedding model of the harness's provider: 3 dimensions, input 0.25 USD per million tokens. */
export const TEST_EMBEDDING_MODEL_A: EmbeddingVerdict = {
  kind: 'allowed',
  model: `${HARNESS_PROVIDER}/test-embed-a`,
  inputUsdPerMTok: 0.25,
  dimensions: 3,
};

/** A second embedding model: 4 dimensions, so pgvector would fail on a comparison with model A's vectors. */
export const TEST_EMBEDDING_MODEL_B: EmbeddingVerdict = {
  kind: 'allowed',
  model: `${HARNESS_PROVIDER}/test-embed-b`,
  inputUsdPerMTok: 0.5,
  dimensions: 4,
};

/** The fixture sources a harness registers unless told otherwise. */
const DEFAULT_SOURCES: readonly FixtureSource[] = ['logs', 'backoffice'];
const ALL_SOURCES: readonly FixtureSource[] = ['logs', 'backoffice', 'tracker'];

/** A heartbeat that never comes within a test: the instance's lease is renewed only by the test. */
const ZOMBIE_HEARTBEAT_MS = 600_000;

/** Polling of {@link waitFor}. */
const SETTLE_POLL_MS = 25;

/** The largest page of `history`. */
const HISTORY_PAGE = 500;

/**
 * The author of every test record: an employee of no test. A record's author id is a uuid (it is the
 * `author.id` of a run's origin, which the snapshot schema checks), while the tests' owners are not.
 */
export const TEST_AUTHOR_ID = randomUUID();

/** An agent record of the library double. */
export type TestRecord = Extract<LibraryDoubleRecord, { kind: 'agent' }>;

/** What a test record may set: the agent's content and the record's id, description, owner and audience. */
export type TestRecordOverrides = Partial<AgentContent> &
  Partial<Pick<LibraryDoubleRecord, 'id' | 'description' | 'ownerId' | 'everyone' | 'viewers' | 'offerInChat'>>;

/**
 * A test agent record: by {@link TEST_AUTHOR_ID}, seen by every employee and offered in the main chat
 * (so a root may start it), with no tools, no servers, no agents, 20 turns and the default model,
 * unless overridden.
 */
export function testRecord(name: string, overrides: TestRecordOverrides = {}): TestRecord {
  const {
    id,
    description = `Test agent ${name}`,
    ownerId = TEST_AUTHOR_ID,
    everyone = true,
    viewers,
    offerInChat = true,
    ...content
  } = overrides;
  return {
    kind: 'agent',
    name,
    description,
    ownerId,
    everyone,
    offerInChat,
    ...(id === undefined ? {} : { id }),
    ...(viewers === undefined ? {} : { viewers }),
    content: {
      prompt: 'You are a test agent.',
      servers: [],
      model: TEST_MODEL_DEFAULT,
      maxTurns: 20,
      agents: [],
      tools: [],
      ...content,
    },
  };
}

/** A deep agent record of the library double. */
export type TestDeepAgentRecord = Extract<LibraryDoubleRecord, { kind: 'deep_agent' }>;
export type TestSubagent = DeepAgentContent['subagents'][number];

/** What a test deep agent record may set besides its content: its id, description, owner and audience. */
export type TestDeepAgentOverrides = Partial<
  Pick<TestDeepAgentRecord, 'id' | 'description' | 'ownerId' | 'ownerName' | 'everyone' | 'viewers' | 'offerInChat'>
>;

/**
 * A subagent of a test deep agent: a description line and a prompt by its name, no servers, 2 turns, one
 * run and the default model, unless overridden.
 */
export function testSubagent(name: string, overrides: Partial<TestSubagent> = {}): TestSubagent {
  return {
    name,
    description: `The ${name} of the team`,
    prompt: `You are the test subagent ${name}.`,
    servers: [],
    model: TEST_MODEL_DEFAULT,
    maxTurns: 2,
    maxRuns: 1,
    ...overrides,
  };
}

/**
 * A test deep agent record: by {@link TEST_AUTHOR_ID}, seen by every employee and offered in the main chat
 * (so a root may start it), unless overridden.
 */
export function testDeepAgent(
  name: string,
  content: DeepAgentContent,
  overrides: TestDeepAgentOverrides = {},
): TestDeepAgentRecord {
  return {
    kind: 'deep_agent',
    name,
    ownerId: TEST_AUTHOR_ID,
    everyone: true,
    offerInChat: true,
    ...overrides,
    content,
  };
}

/**
 * Makes `record` the root of the next `sessions.start`: the double's `chat` record (a system record every
 * employee sees) gets its name and content — added on the first call, a new version after it. A run
 * already started keeps its snapshot.
 */
export async function setRootRecord(library: LibraryDouble, record: TestRecord): Promise<void> {
  const body = { kind: 'agent' as const, content: record.content };
  const chat = (await library.listVisible(TEST_AUTHOR_ID)).find(
    (header) => header.builtinKey === CHAT_BUILTIN_KEY,
  );
  if (chat === undefined) {
    library.add({ ...body, name: record.name, ownerId: null, everyone: true, builtinKey: CHAT_BUILTIN_KEY });
    return;
  }
  library.edit(chat.id, { name: record.name, body });
}

/** The tool {@link AgentsHarnessSettings.deepAgentStarter} registers. */
export const START_TEST_DEEP_AGENT = 'start_test_deep_agent';

const StartTestDeepAgentArgsSchema = z.object({
  deepAgent: z.string(),
  prompt: z.string(),
  description: z.string(),
});

/**
 * The test's stand-in for `start_deep_agent`, without the brief card: at the root it starts the deep agent
 * record by id as the root's child, on the snapshot `resolveStart` gives the root's owner, and returns a
 * refusal as `start_agent` does. Only the brief tests go through the real `start_deep_agent`.
 */
function startTestDeepAgentTool(
  agents: Agents,
): InCommitAgentTool<z.infer<typeof StartTestDeepAgentArgsSchema>, StartResolution> {
  return {
    name: START_TEST_DEEP_AGENT,
    description: 'Start a deep agent record by its id.',
    argsSchema: StartTestDeepAgentArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    prepare: ({ args, caller }) =>
      agents.resolveStart({
        ownerId: caller.ownerId,
        source: { kind: 'record', recordId: args.deepAgent, expected: 'deep_agent' },
      }),
    async execute({ args, startChild, prepared }) {
      if (prepared === undefined) throw new Error(`${START_TEST_DEEP_AGENT} runs without its prepare`);
      if (prepared.kind === 'refused') {
        return {
          kind: 'refused',
          reason: prepared.reason,
          refusalDetail: prepared.model === null ? null : { model: prepared.model },
        };
      }
      const { agentId } = await startChild({
        snapshot: prepared.snapshot,
        prompt: args.prompt,
        description: args.description,
      });
      return { kind: 'done', outcome: 'success', text: `Deep agent started, agentId ${agentId}`, childAgentId: agentId };
    },
  };
}

/**
 * The client under `ModelClient`: the scripted double's, or with `turnClient: 'real'` the real
 * `createMastraTurnClient()`, whose requests go to the address of the model's provider row.
 */
type HarnessTurnClient =
  | { readonly model: ScriptedModel; readonly turnClient?: never }
  | { readonly turnClient: 'real'; readonly model?: never };

export type AgentsHarnessOptions = HarnessTurnClient & AgentsHarnessSettings;

interface AgentsHarnessSettings {
  /** Server rights of the test: employee id (or `*`) → server names of the run (`mcp-servers.ts`); the access gate double. */
  readonly access: Readonly<Record<string, readonly string[]>>;
  /** The library every start asks; shared with a second instance; a fresh double by default. */
  readonly library?: LibraryDouble;
  /** Made the library's `chat` record ({@link setRootRecord}) before `start()`: what `sessions.start` runs. */
  readonly root?: TestRecord;
  /** Registers {@link START_TEST_DEEP_AGENT} before `start()`: a root may start a deep agent record. */
  readonly deepAgentStarter?: boolean;
  /** Shared with a second instance; a fresh directory by default. */
  readonly fixture?: FixtureFiles;
  /** `AGENT_*` / `MCP_*` / `CODE_RUN_*` variables over the harness defaults. */
  readonly variables?: Readonly<Record<string, string>>;
  /**
   * Sources whose run servers the harness registers at its fixture process's shared-token paths;
   * `logs` and `backoffice` by default. `[]` registers nothing and deletes the run's servers an earlier
   * harness of the file left (a test that registers its own).
   */
  readonly mcpServers?: readonly FixtureSource[];
  /** Owners the access gate double answers `owner_disabled` for; every owner is active by default. */
  readonly refusedOwners?: readonly string[];
  /** `{ <owner id>: { <model>: <refusal> } }` of the access gate double; read on every question, so a test may withdraw a model mid-run. */
  readonly ownerModelRefusals?: AccessGateDoubleOptions['ownerModelRefusals'];
  /** The code executor; the real one (`createCodeRunner`) by default. */
  readonly codeRunner?: CodeRunner;
  /** Runtime settings over the harness defaults (workers on, 6 slots, short polls and lease). */
  readonly runtimeConfig?: Partial<RuntimeConfig>;
  /** A zombie instance: its heartbeat never renews the lease, so `expireLease` hands its step to another instance. */
  readonly zombie?: boolean;
  /** Catalogue prices of the test's own models, next to the harness's two; the access gate double answers them. */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
  /** Gets every text part of an agent's answer (`createAgents`' `onTextDelta`); none by default. */
  readonly onTextDelta?: (delta: TextDelta) => void;
  /** The embeddings double under the service; shared with a second instance; a fresh one by default. */
  readonly embeddings?: ScriptedEmbeddings;
}

export interface AgentsHarness {
  readonly runtime: Runtime;
  readonly agents: Agents;
  readonly sessions: AgentSessions;
  /** The library double every start of this instance asks. */
  readonly library: LibraryDouble;
  /** The Drizzle client of the harness's pool; the tests only read through it (and `expireLease`). */
  readonly db: Database;
  readonly fixture: FixtureFiles;
  /** The harness's fixture process, writing into {@link fixture}. */
  readonly fixtureProcess: FixtureProcess;
  /** Every record runtime and agents logged, in order. */
  readonly logs: readonly LogRecord[];
  /** Every record `createAgents` gave its audit port, in order (the API hook writes each as is). */
  readonly auditEntries: readonly AuditRecord[];
  /** The embeddings double `createAgents` got: its calls, `vectorOf`, `failure`. */
  readonly embeddings: ScriptedEmbeddings;
  /**
   * What the access gate double answers for embeddings, read on every question: {@link NO_EMBEDDING_MODEL}
   * until the test sets {@link TEST_EMBEDDING_MODEL_A} or {@link TEST_EMBEDDING_MODEL_B}.
   */
  embeddingVerdict: EmbeddingVerdict;
  /**
   * Stops the workers, the agents, deletes the provider row when this is the file's last open harness, closes
   * the pool, then the fixture process — each also when the one before fails.
   */
  close(): Promise<void>;
}

function turnClientOf(options: HarnessTurnClient): AgentTurnModelClient {
  return options.turnClient === 'real' ? createMastraTurnClient() : options.model.turnClient;
}

/** Open harnesses of this test file (files run one at a time): the provider row lives while one of them does. */
let openHarnesses = 0;

/**
 * The first open harness of the file sets the row {@link HARNESS_PROVIDER} to `openai_compatible`, the kind's
 * address, no key, enabled, replacing a row an earlier run left or changed. A later harness of the file (a second
 * instance) finds it and leaves it as the test made it.
 */
async function openHarnessProvider(db: Database): Promise<void> {
  openHarnesses += 1;
  if (openHarnesses > 1) return;
  const row = { kind: 'openai_compatible', baseUrl: null, apiKey: null, enabled: true } as const;
  await db
    .insert(agentModelProviders)
    .values({ name: HARNESS_PROVIDER, ...row })
    .onConflictDoUpdate({ target: agentModelProviders.name, set: { ...row, updatedAt: sql`now()` } });
}

/** The last harness of the file to close deletes the row: the developer's database keeps only its own providers. */
async function closeHarnessProvider(db: Database): Promise<void> {
  openHarnesses -= 1;
  if (openHarnesses > 0) return;
  await db.delete(agentModelProviders).where(eq(agentModelProviders.name, HARNESS_PROVIDER));
}

/**
 * Builds runtime + agents against the test database and starts them: the scripted model (or the real turn
 * client), the scripted embeddings and the access gate double whose default chat model is {@link TEST_MODEL_DEFAULT}.
 */
export async function createAgentsHarness(options: AgentsHarnessOptions): Promise<AgentsHarness> {
  const fixture = options.fixture ?? createFixtureFiles('agents-e2e');
  const runtimeConfig: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 6,
    pollMs: 50,
    leaseMs: 5_000,
    heartbeatMs: options.zombie === true ? ZOMBIE_HEARTBEAT_MS : 1_000,
    reaperMs: 200,
    shutdownGraceMs: 1_000,
    dbPoolMax: 8,
    ...options.runtimeConfig,
  };
  const agentsConfig = parseAgentsConfig({
    MCP_CALL_TIMEOUT_MS: '90000',
    NODE_ENV: 'test',
    ...options.variables,
  });
  const sink = memorySink();
  const auditEntries: AuditRecord[] = [];
  const logger = createLogger({ sinks: [sink], secrets: [], minLevel: 'debug' });
  const library = options.library ?? createLibraryDouble();
  const embeddings = options.embeddings ?? createScriptedEmbeddings();
  let embeddingVerdict = NO_EMBEDDING_MODEL;
  if (options.root !== undefined) await setRootRecord(library, options.root);
  const fixtureProcess = await startFixtureProcess(fixture);
  const database = createDatabase({
    connectionString: databaseUrl(),
    poolMax: runtimeConfig.dbPoolMax,
  });
  const runtime = createRuntime({
    database,
    config: runtimeConfig,
    logger,
    clock: systemClock,
  });
  const agents = createAgents({
    database: database.db,
    runtime,
    logger,
    config: agentsConfig,
    turnClient: turnClientOf(options),
    embeddingClient: embeddings.client,
    access: createAccessGateDouble({
      servers: options.access,
      prices: { ...TEST_MODEL_PRICES, ...options.prices },
      defaultChatModel: TEST_MODEL_DEFAULT,
      embedding: () => embeddingVerdict,
      ...(options.refusedOwners === undefined ? {} : { refusedOwners: options.refusedOwners }),
      ...(options.ownerModelRefusals === undefined ? {} : { ownerModelRefusals: options.ownerModelRefusals }),
    }),
    audit: async (entry) => {
      auditEntries.push(entry);
    },
    library,
    ...(options.codeRunner === undefined ? {} : { codeRunner: options.codeRunner }),
    ...(options.onTextDelta === undefined ? {} : { onTextDelta: options.onTextDelta }),
  });
  if (options.deepAgentStarter === true) agents.tools.register(startTestDeepAgentTool(agents));

  const close = async () => {
    try {
      await runtime.stop();
    } finally {
      try {
        await agents.stop();
      } finally {
        try {
          await closeHarnessProvider(database.db);
        } finally {
          try {
            await database.close();
          } finally {
            await fixtureProcess.stop();
          }
        }
      }
    }
  };
  try {
    // First in the block: `close` below then always pairs with this open.
    await openHarnessProvider(database.db);
    await agents.start();
    const sources = options.mcpServers ?? DEFAULT_SOURCES;
    if (sources.length === 0) {
      for (const source of ALL_SOURCES) await removeServer(agents, runName(source));
    }
    await registerFixtureServers(agents, fixtureProcess, sources);
  } catch (error) {
    await close();
    throw error;
  }
  runtime.start();

  return {
    runtime,
    agents,
    sessions: agents.sessions,
    library,
    db: database.db,
    fixture,
    fixtureProcess,
    logs: sink.records,
    auditEntries,
    embeddings,
    get embeddingVerdict() {
      return embeddingVerdict;
    },
    set embeddingVerdict(verdict) {
      embeddingVerdict = verdict;
    },
    close,
  };
}

/** Closes every harness the test opened, also when one of them fails to close. */
export async function closeAll(harnesses: readonly AgentsHarness[]): Promise<void> {
  const closed = await Promise.allSettled(harnesses.map((harness) => harness.close()));
  const failed = closed.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

/**
 * Moves the lease of the task's running step into the past, as if its process had stopped beating: the
 * next pass of a recovery sweeper requeues the step. The one write of the tests to `runtime_*` (as in the
 * runtime part's harness). Throws when the task is not `running`.
 */
export async function expireLease(db: Database, taskId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE app.runtime_tasks SET lease_expires_at = now() - interval '1 minute'
     WHERE task_id = ${taskId} AND status = 'running'
    RETURNING task_id`);
  if (rows.length !== 1) throw new Error(`Task ${taskId} has no running step to expire`);
}

/**
 * Polls `read` until `done` holds and returns that value; fails naming `what` and the last value after
 * `timeoutMs`. Tests synchronise on rows and latches with it, never on sleeps.
 */
export async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(value)}`);
    }
    await delay(SETTLE_POLL_MS);
    value = await read();
  }
  return value;
}

/** Waits until the runtime task of the agent has `status` and returns it. */
export function waitForTaskStatus(
  harness: AgentsHarness,
  agentId: string,
  ownerId: string,
  status: Task['status'],
): Promise<Task> {
  return waitFor(
    () => harness.runtime.tasks.get(agentId, ownerId),
    (task) => task.status === status,
    `agent ${agentId} to be ${status}`,
  );
}

/** Waits until the agent's view has `status` (60 s: a finished deep agent run) and returns the view. */
export function waitForStatus(
  harness: AgentsHarness,
  agentId: string,
  ownerId: string,
  status: AgentView['status'],
): Promise<AgentView> {
  return waitFor(
    () => harness.sessions.get(agentId, ownerId),
    (view) => view.status === status,
    `agent ${agentId} to be ${status}`,
    60_000,
  );
}

/** The deep agents in the root's tree: agents started from a deep agent record, not its subagents. */
export async function deepAgentsUnder(
  harness: AgentsHarness,
  rootId: string,
  ownerId: string,
): Promise<AgentView[]> {
  return (await harness.sessions.list(rootId, ownerId)).filter(
    (view) => view.origin?.kind === 'deep_agent' && view.origin.subagent === null,
  );
}

/** The reports of an agent's children it received (`child_report` entries), in order. */
export async function childReportsOf(harness: AgentsHarness, agentId: string, ownerId: string) {
  return (await historyOf(harness, agentId, ownerId)).flatMap((entry) =>
    entry.kind === 'child_report' ? [entry.content] : [],
  );
}

/** The whole history of an agent through `agents.history`. */
export function historyOf(
  harness: AgentsHarness,
  agentId: string,
  ownerId: string,
): Promise<AgentHistoryEntry[]> {
  return harness.sessions.history({ agentId, ownerId, limit: HISTORY_PAGE });
}

/**
 * A history as short literal lines — `task: <text>`, `model_answer: <text> [<server>/<tool>, …]`,
 * `tool_result: <tool> <outcome>[ <reason>]`, `child_report: <description> <status>[ <reason>]`,
 * `event: <event>[ <reason>]`, `compaction: <summary>`; the tests compare them with expected literals.
 */
export function historyLines(entries: readonly AgentHistoryEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'task':
      case 'user_message':
      case 'agent_message':
      case 'notice':
        return `${entry.kind}: ${entry.content.text}`;
      case 'model_answer': {
        const tools = entry.content.toolCalls.map((call) =>
          call.server === null ? call.tool : `${call.server}/${call.tool}`,
        );
        return `model_answer: ${entry.content.text} [${tools.join(', ')}]`;
      }
      case 'tool_result': {
        const { tool, outcome, refusalReason } = entry.content;
        return `tool_result: ${tool} ${outcome}${refusalReason === null ? '' : ` ${refusalReason}`}`;
      }
      case 'child_report': {
        const { description, status, reason } = entry.content;
        return `child_report: ${description} ${status}${reason === null ? '' : ` ${reason}`}`;
      }
      case 'event':
        return `event: ${entry.content.event}${entry.content.reason === null ? '' : ` ${entry.content.reason}`}`;
      case 'compaction':
        return `compaction: ${entry.content.summary}`;
    }
  });
}

/** A `child_finished` notice in a parent's queue as stored, delivered or not. */
export interface ChildNotice {
  readonly seq: number;
  readonly status: string;
  readonly payload: {
    readonly taskId: string;
    readonly status: string;
    readonly result?: { readonly report?: string };
    readonly failure?: { readonly reason: string };
  };
}

/** The runtime's end notices about `childId` in the parent's queue, by `seq`. */
export async function childNoticesOf(
  db: Database,
  parentId: string,
  childId: string,
): Promise<ChildNotice[]> {
  const rows = await db
    .select({ seq: runtimeInbox.seq, status: runtimeInbox.status, payload: runtimeInbox.payload })
    .from(runtimeInbox)
    .where(and(eq(runtimeInbox.recipientId, parentId), eq(runtimeInbox.kind, 'child_finished')))
    .orderBy(asc(runtimeInbox.seq));
  return rows
    .map((row) => ({ ...row, payload: row.payload as ChildNotice['payload'] }))
    .filter((row) => row.payload.taskId === childId);
}

/** Runtime events about a task, by `seq`. */
export function eventsOf(db: Database, taskId: string) {
  return db
    .select({ type: runtimeEvents.type, payload: runtimeEvents.payload })
    .from(runtimeEvents)
    .where(eq(runtimeEvents.taskId, taskId))
    .orderBy(asc(runtimeEvents.seq));
}

/**
 * The token ledger rows of an owner (`PLATFORM_OWNER_ID` for the platform's own calls), of one task when
 * `taskId` is given, in order of the call: an embedding row tells itself by its model.
 */
export function ledgerRowsOf(db: Database, ownerId: string, taskId?: string) {
  return db
    .select({
      taskId: runtimeModelCalls.taskId,
      model: runtimeModelCalls.model,
      callId: runtimeModelCalls.callId,
      inputTokens: runtimeModelCalls.inputTokens,
      costUsd: runtimeModelCalls.costUsd,
    })
    .from(runtimeModelCalls)
    .where(
      and(
        eq(runtimeModelCalls.ownerId, ownerId),
        taskId === undefined ? undefined : eq(runtimeModelCalls.taskId, taskId),
      ),
    )
    .orderBy(asc(runtimeModelCalls.calledAt));
}

/** The audit rows of the tool calls one `run_code` run's script made, by attempt and number. */
export function codeCallRowsOf(db: Database, agentId: string, runCallId: string) {
  return db
    .select()
    .from(agentCodeCalls)
    .where(and(eq(agentCodeCalls.taskId, agentId), eq(agentCodeCalls.runCallId, runCallId)))
    .orderBy(asc(agentCodeCalls.attempt), asc(agentCodeCalls.seq));
}

/** Every log record of one `run_code` run (its `runId` is the run's `callId`), in order. */
export function runLogsOf(harness: AgentsHarness, runId: string): LogRecord[] {
  return harness.logs.filter((record) => record.fields.runId === runId);
}

/** What the model got as the result of one of its earlier tool calls, as text. */
export function toolOutputOf(messages: readonly AgentTurnMessage[], toolCallId: string | undefined): string {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const result = message.results.find((candidate) => candidate.toolCallId === toolCallId);
    if (result !== undefined) {
      return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    }
  }
  throw new Error(`The model input holds no result of call ${String(toolCallId)}`);
}

/**
 * Row versions (`xmin`) of everything the agents and the runtime keep about the given agents: their
 * `agent_sessions`, `agent_messages` and `runtime_tasks` rows, one sorted line each
 * (`<table> <task id> [<key>] <version>`). Equal snapshots mean no row was written, added or removed —
 * tool calls included: a call and every change of it are `agent_messages` rows.
 */
export async function treeRowVersionsOf(db: Database, taskIds: readonly string[]): Promise<string[]> {
  const ids = sql.join(
    taskIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute(sql`
    SELECT concat_ws(' ', 'session', task_id, xmin) AS line FROM app.agent_sessions WHERE task_id IN (${ids})
    UNION ALL
    SELECT concat_ws(' ', 'message', task_id, seq, xmin) FROM app.agent_messages WHERE task_id IN (${ids})
    UNION ALL
    SELECT concat_ws(' ', 'task', task_id, xmin) FROM app.runtime_tasks WHERE task_id IN (${ids})
    ORDER BY 1`);
  return rows.map((row) => String(row.line));
}

/** Every history row of an agent with its row version (`xmin` changes on every update of the row), by `seq`. */
export async function historyRowVersionsOf(
  db: Database,
  agentId: string,
): Promise<{ seq: number; version: string }[]> {
  const { rows } = await db.execute(sql`
    SELECT seq, xmin::text AS version FROM app.agent_messages
     WHERE task_id = ${agentId} ORDER BY seq`);
  return rows.map((row) => ({ seq: Number(row.seq), version: String(row.version) }));
}

/** The task list of a run as `<number> <status> <text>` lines, by number, read from `agent_run_tasks`. */
export async function planRowsOf(db: Database, sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ number: agentRunTasks.number, status: agentRunTasks.status, text: agentRunTasks.text })
    .from(agentRunTasks)
    .where(eq(agentRunTasks.taskId, sessionId))
    .orderBy(asc(agentRunTasks.number));
  return rows.map((row) => `${row.number} ${row.status} ${row.text}`);
}

/** The first line of the plan block a deep agent's step puts in its system text (`step/plan-block.ts`). */
export const PLAN_BLOCK_HEADING = 'Your plan (task_list of this run), by number; your own notes, not instructions:';

/**
 * The plan block of a recorded model call, line by line: from its heading to the next empty line of the
 * system text (the model client's standing rules follow the definition's text); empty when the call has none.
 */
export function planBlockLinesOf(instructions: string): string[] {
  const start = instructions.indexOf(PLAN_BLOCK_HEADING);
  if (start === -1) return [];
  const end = instructions.indexOf('\n\n', start);
  return instructions.slice(start, end === -1 ? undefined : end).split('\n');
}
