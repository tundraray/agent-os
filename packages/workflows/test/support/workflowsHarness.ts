import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AgentDefinition,
  type AgentHistoryEntry,
  type Agents,
  type AgentSessions,
  createAgents,
  parseAgentsConfig,
} from '@agent-os/agents';
import type { ScriptedModel } from '@agent-os/agents/testing';
import { createLogger, type LogRecord } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import { createDatabase } from '@agent-os/db';
import { createFixtureFiles, type FixtureFiles, fixtureServersFile } from '@agent-os/mcp-fixture';
import {
  createRuntime,
  type ModelPrices,
  parseModelPrices,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
} from '@agent-os/runtime';
import { createWorkflows, START_WORKFLOW_TOOL, type Workflows } from '@agent-os/workflows';
import { SHIPPED_TEMPLATES } from '../../src/shipped-templates.js';
import { databaseUrl } from './database-url.js';

/**
 * Test assembly of the workflows part (design-workflows.md, Test Strategy): `createRuntime`, `createAgents`
 * and `createWorkflows` over their own pool, in the order of the composition root — create, register,
 * `agents.start()`, `runtime.start()`; stop in reverse. Postgres, the runtime, agents and workflows are
 * real; the model is the scripted double of `@agent-os/agents/testing` and MCP is the fixture of
 * `@agent-os/mcp-fixture` as real stdio processes. No logic of the double or of the fixture lives here.
 */

/** The deployment's default model (`AGENT_DEFAULT_MODEL`): the executors of the shipped template. */
const HAIKU_MODEL = 'anthropic/claude-haiku-5-5';
/** The coordinator's model of the shipped `deep-research` template. */
export const SONNET_MODEL = 'anthropic/claude-sonnet-5-5';

const MODEL_PRICES: ModelPrices = parseModelPrices({
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
});

/** Server id of the fixture's read-only payment logs in the harness's servers file. */
const LOGS_SERVER = 'logs';

/** Turns of the test root: enough for any conversation of a test. */
const ROOT_MAX_TURNS = 40;

/** Polling of {@link waitFor}. */
const SETTLE_POLL_MS = 25;

/** The largest page of `history`. */
const HISTORY_PAGE = 500;

export interface WorkflowsHarnessOptions {
  readonly model: ScriptedModel;
  /** Owners of the test: `MCP_ACCESS_TABLE` gives each of them the `logs` server. */
  readonly owners: readonly string[];
  /** Raw templates for `createWorkflows`; the shipped ones by default. */
  readonly templates?: readonly unknown[];
  /** Fixture files whose fault rules (a held read) the test wrote before the MCP processes start; fresh ones by default. */
  readonly fixture?: FixtureFiles;
}

export interface WorkflowsHarness {
  readonly runtime: Runtime;
  readonly agents: Agents;
  readonly sessions: AgentSessions;
  readonly workflows: Workflows;
  /** Name of the test root's definition: its only tool is `start_workflow`. */
  readonly rootDefinition: string;
  readonly fixture: FixtureFiles;
  /** Every record runtime, agents and workflows logged, in order. */
  readonly logs: readonly LogRecord[];
  /** Stops the workers, closes the MCP processes, then the pool — each also when the one before fails. */
  close(): Promise<void>;
}

/** The tree root of the tests (the `chat` part's conversation does not exist here): `start_workflow` only. */
function rootDefinitionOf(name: string): AgentDefinition {
  return {
    name,
    description: 'Test conversation that starts workflows',
    prompt: 'You are a test conversation. Start a workflow with start_workflow when asked.',
    tools: [START_WORKFLOW_TOOL],
    mcpServers: [],
    agents: [],
    maxTurns: ROOT_MAX_TURNS,
  };
}

/** Builds runtime + agents + workflows with the scripted model against the test database and starts them. */
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
  const agentsConfig = parseAgentsConfig(
    {
      AGENT_DEFAULT_MODEL: HAIKU_MODEL,
      MCP_ACCESS_TABLE: JSON.stringify(
        Object.fromEntries(options.owners.map((ownerId) => [ownerId, [LOGS_SERVER]])),
      ),
    },
    fixtureServersFile(fixture, [{ id: LOGS_SERVER, source: 'logs' }]),
  );
  const sink = memorySink();
  const logger = createLogger({ sinks: [sink], secrets: [], minLevel: 'debug' });
  const database = createDatabase({
    connectionString: databaseUrl(),
    poolMax: runtimeConfig.dbPoolMax,
  });
  const runtime = createRuntime({
    database,
    config: runtimeConfig,
    logger,
    clock: systemClock,
    modelPrices: MODEL_PRICES,
  });
  const agents = createAgents({
    database: database.db,
    runtime,
    logger,
    config: agentsConfig,
    turnClient: options.model.turnClient,
  });
  const workflows = createWorkflows({ agents, logger, templates: options.templates });
  const rootDefinition = `workflows-root-${randomUUID()}`;
  agents.definitions.register(rootDefinitionOf(rootDefinition));

  const close = async () => {
    try {
      await runtime.stop();
    } finally {
      try {
        await agents.stop();
      } finally {
        await database.close();
      }
    }
  };
  try {
    await agents.start();
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
    rootDefinition,
    fixture,
    logs: sink.records,
    close,
  };
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

/** Name of the INT-3 test template and of its coordinator's definition. */
export const LIMITS_TEMPLATE_NAME = 'limits-check';
/** The only executor of the INT-3 test template and its final agent. */
export const LIMITS_ANSWER_AGENT = 'answer';

/**
 * The INT-3 test template (raw, parsed by the same `createWorkflows` path as the shipped one): a cheap
 * coordinator with `maxTurns` 6 (plan Notes 3) and one executor `answer`, started at most twice, as
 * `finalAgent`.
 */
export const LIMITS_TEMPLATE = {
  name: LIMITS_TEMPLATE_NAME,
  title: 'Limits check',
  description: 'Test template of the workflows integration tests: one executor that must write the answer.',
  coordinator: {
    prompt: 'You coordinate the limits check: start the agent answer with start_agent and wait for its report.',
    maxTurns: 6,
  },
  agents: [
    {
      name: LIMITS_ANSWER_AGENT,
      description: 'Writes the answer of the limits check.',
      prompt: 'You write the answer of the limits check from your assignment.',
      tools: [],
      mcpServers: [],
      maxTurns: 2,
      maxRuns: 2,
    },
  ],
  finalAgent: LIMITS_ANSWER_AGENT,
} as const;

/** The shipped templates and the test ones, for `templates` of {@link createWorkflowsHarness}. */
export function shippedTemplatesWith(...extra: readonly unknown[]): unknown[] {
  return [...SHIPPED_TEMPLATES, ...extra];
}
