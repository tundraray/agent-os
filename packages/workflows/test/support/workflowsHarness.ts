import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AgentHistoryEntry,
  type Agents,
  type AgentSessions,
  type AgentView,
  createAgents,
  parseAgentsConfig,
} from '@agent-os/agents';
import {
  createAccessGateDouble,
  createLibraryDouble,
  createScriptedEmbeddings,
  type LibraryDouble,
  type LibraryDoubleRecord,
  type ScriptedModel,
} from '@agent-os/agents/testing';

export { toolCallRowsOf } from '@agent-os/agents/testing';
import { createLogger, type LogRecord } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import { createDatabase, type Database, type DatabaseConnection } from '@agent-os/db';
import {
  createFixtureFiles,
  FIXTURE_SHARED_TOKEN,
  type FixtureFiles,
  type FixtureProcess,
  startFixtureProcess,
} from '@agent-os/mcp-fixture';
import {
  createRuntime,
  type ModelPrice,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
} from '@agent-os/runtime';
import { createWorkflows, type Workflows } from '@agent-os/workflows';
import { inject } from 'vitest';
import { databaseUrl } from './database-url';

/**
 * Test assembly of the workflows package (design-runtime.md, Test Strategy): `createRuntime`, `createAgents`
 * and `createWorkflows` over their own pool, in the order of the composition root — create, register,
 * `agents.start()`, `runtime.start()`; stop in reverse. Postgres, the runtime, agents and workflows are
 * real; the model is the scripted double of `@agent-os/agents/testing`, the library of agents and
 * workflows is its `createLibraryDouble` (the root runs its `chat` record, a workflow is a record the test
 * adds) and MCP is the fixture process of `@agent-os/mcp-fixture` over HTTP, its `logs` source registered
 * in the registry under the run's name {@link LOGS_SERVER}. No logic of the doubles or of the fixture lives here.
 * The model provider is the row {@link HARNESS_PROVIDER} in the database, which the open harnesses of a test
 * file keep and the last one deletes.
 */

/**
 * The model provider of every harness (model-providers design-core.md, Test Strategy): an `openai_compatible`
 * row without a key, so it is `ready`. Never `anthropic`: the tests run on the developer's database, whose
 * `anthropic` row may hold a real key.
 */
const HARNESS_PROVIDER = 'workflows-harness';

/** The default chat model of the access gate double: the root and the executors of a test workflow. */
export const HAIKU_MODEL = `${HARNESS_PROVIDER}/claude-haiku-5-5`;
/** A second priced model: the coordinator of the `deep-research` test workflow. */
export const SONNET_MODEL = `${HARNESS_PROVIDER}/claude-sonnet-5-5`;

/** The model catalogue of the access gate double: both models. */
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  [HAIKU_MODEL]: {
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    cacheWriteUsdPerMTok: 0.125,
    cacheReadUsdPerMTok: 0.01,
  },
  [SONNET_MODEL]: {
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    cacheWriteUsdPerMTok: 2.5,
    cacheReadUsdPerMTok: 0.1,
  },
};

declare module 'vitest' {
  export interface ProvidedContext {
    /** Six hex digits that end every MCP server name of this test run (`-t<runId>`). */
    mcpRunId: string;
  }
}

/**
 * The run's server of the fixture's read-only payment logs. The tests run on the developer's database, whose
 * registry has its own `logs` (`seed:mcp`): the run's servers are `<source>-t<runId>`, and the global setup
 * deletes them after the run.
 */
export const LOGS_SERVER = `logs-t${inject('mcpRunId')}`;

/** The OAuth return address the registration of {@link LOGS_SERVER} names; a shared-token server never uses it. */
const MCP_REDIRECT_URL = `http://localhost:3000/api/mcp/oauth/callback/${LOGS_SERVER}`;

/** `builtinKey` of the library's `chat` record (`CHAT_BUILTIN_KEY` of `@agent-os/contracts`): what a root runs. */
const CHAT_BUILTIN_KEY = 'chat';

/** Name of the test root: the conversation that starts workflows. */
export const ROOT_NAME = 'workflows-root';

/** Turns of the test root: enough for any conversation of a test. */
const ROOT_MAX_TURNS = 40;

/** Polling of {@link waitFor}. */
const SETTLE_POLL_MS = 25;

/** The largest page of `history`. */
const HISTORY_PAGE = 500;

/**
 * The author of every test workflow unless a test names another: an employee of no test. A record's
 * author id is a uuid (it is the `author.id` of a run's origin, which the snapshot schema checks), while
 * the tests' owners are not.
 */
export const TEST_AUTHOR_ID = randomUUID();

/** A workflow record of the library double. */
export type TestWorkflowRecord = Extract<LibraryDoubleRecord, { kind: 'workflow' }>;
export type TestWorkflowContent = TestWorkflowRecord['content'];
export type TestExecutor = TestWorkflowContent['executors'][number];
/** An agent record of the library double. */
export type TestAgentRecord = Extract<LibraryDoubleRecord, { kind: 'agent' }>;

/** What a test workflow record may set besides its content: its id, description, owner and audience. */
export type TestWorkflowOverrides = Partial<
  Pick<TestWorkflowRecord, 'id' | 'description' | 'ownerId' | 'ownerName' | 'everyone' | 'viewers' | 'offerInChat'>
>;

/**
 * An executor of a test workflow: a role line and a prompt by its name, no servers or tools, 2 turns, one
 * run and the default model, copied from no record, unless overridden.
 */
export function testExecutor(name: string, overrides: Partial<TestExecutor> = {}): TestExecutor {
  return {
    name,
    role: `The ${name} of the team`,
    prompt: `You are the test executor ${name}.`,
    servers: [],
    model: HAIKU_MODEL,
    maxTurns: 2,
    maxRuns: 1,
    tools: [],
    source: null,
    ...overrides,
  };
}

/**
 * A test workflow record: by {@link TEST_AUTHOR_ID}, seen by every employee and offered in the main chat
 * (so the root may start it), unless overridden.
 */
export function testWorkflow(
  name: string,
  content: TestWorkflowContent,
  overrides: TestWorkflowOverrides = {},
): TestWorkflowRecord {
  return {
    kind: 'workflow',
    name,
    ownerId: TEST_AUTHOR_ID,
    everyone: true,
    offerInChat: true,
    ...overrides,
    content,
  };
}

/** The root every `sessions.start` runs: no tools of its own, so `start_workflow` (root-only) is all it may call. */
const ROOT_RECORD: TestAgentRecord = {
  kind: 'agent',
  name: ROOT_NAME,
  ownerId: null,
  everyone: true,
  builtinKey: CHAT_BUILTIN_KEY,
  content: {
    prompt: 'You are a test conversation. Start a workflow with start_workflow when asked.',
    servers: [],
    model: HAIKU_MODEL,
    maxTurns: ROOT_MAX_TURNS,
    agents: [],
    tools: [],
  },
};

export interface WorkflowsHarnessOptions {
  readonly model: ScriptedModel;
  /** Owners of the test: the access gate double gives each of them the `logs` server. */
  readonly owners: readonly string[];
  /** Fixture files whose fault rules (a held read) the test wrote; fresh ones by default. */
  readonly fixture?: FixtureFiles;
}

export interface WorkflowsHarness {
  readonly runtime: Runtime;
  readonly agents: Agents;
  readonly sessions: AgentSessions;
  readonly workflows: Workflows;
  /** The library every start asks: its `chat` record is the root; the test adds and edits workflows in it. */
  readonly library: LibraryDouble;
  /** The Drizzle client of the harness's pool; the tests only read through it. */
  readonly db: Database;
  readonly fixture: FixtureFiles;
  /** The harness's fixture process, writing into {@link fixture}. */
  readonly fixtureProcess: FixtureProcess;
  /** Every record runtime, agents and workflows logged, in order. */
  readonly logs: readonly LogRecord[];
  /**
   * Stops the workers, the agents, deletes the provider row when this is the file's last open harness, closes
   * the pool, then the fixture process — each also when the one before fails.
   */
  close(): Promise<void>;
}

/** Open harnesses of this test file (files run one at a time): the provider row lives while one of them does. */
let openHarnesses = 0;

/**
 * The first open harness of the file sets the row {@link HARNESS_PROVIDER} to `openai_compatible`, the kind's
 * address, no key, enabled, replacing a row an earlier run left or changed; a later harness of the file leaves
 * it as it is. SQL through the pool: `drizzle-orm` is not a dependency of this package.
 */
async function openHarnessProvider(database: DatabaseConnection): Promise<void> {
  openHarnesses += 1;
  if (openHarnesses > 1) return;
  await database.pool.query(
    `INSERT INTO app.agent_model_providers (name, kind) VALUES ($1, 'openai_compatible')
     ON CONFLICT (name) DO UPDATE
       SET kind = 'openai_compatible', base_url = NULL, api_key = NULL, enabled = true, updated_at = now()`,
    [HARNESS_PROVIDER],
  );
}

/** The last harness of the file to close deletes the row: the developer's database keeps only its own providers. */
async function closeHarnessProvider(database: DatabaseConnection): Promise<void> {
  openHarnesses -= 1;
  if (openHarnesses > 0) return;
  await database.pool.query('DELETE FROM app.agent_model_providers WHERE name = $1', [HARNESS_PROVIDER]);
}

/**
 * Builds runtime + agents + workflows against the test database and starts them: the scripted model and
 * embeddings, and the access gate double whose default chat model is {@link HAIKU_MODEL}.
 */
export async function createWorkflowsHarness(options: WorkflowsHarnessOptions): Promise<WorkflowsHarness> {
  const fixture = options.fixture ?? createFixtureFiles('workflows-e2e');
  const runtimeConfig: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 6,
    pollMs: 50,
    leaseMs: 5_000,
    heartbeatMs: 1_000,
    reaperMs: 200,
    shutdownGraceMs: 1_000,
    dbPoolMax: 8,
  };
  const agentsConfig = parseAgentsConfig({ NODE_ENV: 'test' });
  const sink = memorySink();
  const logger = createLogger({ sinks: [sink], secrets: [], minLevel: 'debug' });
  const library = createLibraryDouble();
  library.add(ROOT_RECORD);
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
    turnClient: options.model.turnClient,
    embeddingClient: createScriptedEmbeddings().client,
    // Every owner of these tests is active; no test here asserts the audit hook.
    access: createAccessGateDouble({
      servers: Object.fromEntries(options.owners.map((ownerId) => [ownerId, [LOGS_SERVER]])),
      prices: MODEL_PRICES,
      defaultChatModel: HAIKU_MODEL,
    }),
    audit: async () => {},
    library,
  });
  const workflows = createWorkflows({ agents, logger });

  const close = async () => {
    try {
      await runtime.stop();
    } finally {
      try {
        await agents.stop();
      } finally {
        try {
          await closeHarnessProvider(database);
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
    await openHarnessProvider(database);
    await agents.start();
    await registerLogsServer(agents, fixtureProcess);
  } catch (error) {
    await close();
    throw error;
  }
  runtime.start();

  return {
    runtime,
    agents,
    sessions: agents.sessions,
    workflows,
    library,
    db: database.db,
    fixture,
    fixtureProcess,
    logs: sink.records,
    close,
  };
}

/**
 * Points the run's {@link LOGS_SERVER} at this harness's fixture process: the row an earlier harness of the
 * run left (its process stopped) is replaced.
 */
async function registerLogsServer(agents: Agents, fixtureProcess: FixtureProcess): Promise<void> {
  if ((await agents.mcp.list()).some((server) => server.name === LOGS_SERVER)) {
    await agents.mcp.remove(LOGS_SERVER);
  }
  await agents.mcp.register({
    name: LOGS_SERVER,
    url: fixtureProcess.sharedUrl('logs'),
    mode: 'shared',
    sharedToken: FIXTURE_SHARED_TOKEN,
    redirectUrl: MCP_REDIRECT_URL,
  });
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

/** Waits until the agent has `status` (a finished one: 60 s) and returns its view. */
export function waitForStatus(
  harness: WorkflowsHarness,
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

/** The coordinators of workflow runs in the root's tree: agents started from a workflow record, not its executors. */
export async function coordinatorsUnder(
  harness: WorkflowsHarness,
  rootId: string,
  ownerId: string,
): Promise<AgentView[]> {
  return (await harness.sessions.list(rootId, ownerId)).filter(
    (view) => view.origin?.kind === 'workflow' && view.origin.executor === null,
  );
}

/** The whole history of an agent through `agents.sessions.history`. */
export function historyOf(
  harness: WorkflowsHarness,
  agentId: string,
  ownerId: string,
): Promise<AgentHistoryEntry[]> {
  return harness.sessions.history({ agentId, ownerId, limit: HISTORY_PAGE });
}

/** The reports of an agent's children it received (`child_report` entries), in order. */
export async function childReportsOf(harness: WorkflowsHarness, agentId: string, ownerId: string) {
  return (await historyOf(harness, agentId, ownerId)).flatMap((entry) =>
    entry.kind === 'child_report' ? [entry.content] : [],
  );
}
