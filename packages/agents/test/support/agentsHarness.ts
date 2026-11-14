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
import { createLogger, type LogRecord } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import {
  agentToolCalls,
  createDatabase,
  type Database,
  runtimeEvents,
  runtimeInbox,
  runtimeModelCalls,
} from '@agent-os/db';
import { createFixtureFiles, type FixtureFiles, fixtureServersFile } from '@agent-os/mcp-fixture';
import type { ScriptedModel } from '@agent-os/agents/testing';
import {
  createRuntime,
  type ModelPrices,
  parseModelPrices,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
  type Task,
} from '@agent-os/runtime';
import { and, asc, eq, sql } from 'drizzle-orm';
import { databaseUrl } from './database-url.js';

/**
 * Test assembly of the agents part (design-agents.md, Test Strategy): the package's own `createRuntime` and
 * `createAgents` over their own pool, without `apps/api`. Postgres, the runtime and every agents component
 * are real; the model is the scripted double under `ModelClient` (plan Notes 9) and MCP is the fixture as
 * real stdio processes. A second instance ("the restarted server") is a second harness over the same
 * database and the same fixture files.
 */

/** The deployment's default model (`AGENT_DEFAULT_MODEL`): input 1, output 5 USD per million tokens. */
const TEST_MODEL_DEFAULT = 'anthropic/test-default';
/** A second priced model a launch may name: input 3, output 15 USD per million tokens. */
export const TEST_MODEL_CHOSEN = 'anthropic/test-chosen';

/** Prices of every harness: both models, rates exact in binary. */
const TEST_MODEL_PRICES: ModelPrices = parseModelPrices({
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
});

/** Server ids of the fixture servers file: read-only payment logs and the back office with `create_incident_note`. */
export const LOGS_SERVER = 'logs';
export const BACKOFFICE_SERVER = 'backoffice';

/** A heartbeat that never comes within a test: the instance's lease is renewed only by the test. */
const ZOMBIE_HEARTBEAT_MS = 600_000;

/** Polling of {@link waitFor}. */
const SETTLE_POLL_MS = 25;

/** The largest page of `history`. */
const HISTORY_PAGE = 500;

/** The servers file of a harness: both fixture servers, logging into the test's call log. */
function fixtureServers(files: FixtureFiles): unknown {
  return fixtureServersFile(files, [
    { id: LOGS_SERVER, source: 'logs' },
    { id: BACKOFFICE_SERVER, source: 'backoffice' },
  ]);
}

/** A definition name unique to one test: catalogs of other tests never meet it. */
export function uniqueName(label: string): string {
  return `${label}-${randomUUID()}`;
}

/** A test definition: no tools, no servers, no agents, 20 turns, unless overridden. */
export function testDefinition(
  name: string,
  overrides: Partial<Omit<AgentDefinition, 'name'>> = {},
): AgentDefinition {
  return {
    name,
    description: `Test agent ${name}`,
    prompt: 'You are a test agent.',
    tools: [],
    mcpServers: [],
    agents: [],
    maxTurns: 20,
    ...overrides,
  };
}

export interface AgentsHarnessOptions {
  readonly model: ScriptedModel;
  /** `MCP_ACCESS_TABLE` of the test: employee id → server ids. */
  readonly access: Readonly<Record<string, readonly string[]>>;
  /** Registered before `start()`. */
  readonly definitions?: readonly AgentDefinition[];
  /** Shared with a second instance; a fresh directory by default. */
  readonly fixture?: FixtureFiles;
  /** `AGENT_*` / `MCP_*` variables over the harness defaults. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Runtime settings over the harness defaults (workers on, 6 slots, short polls and lease). */
  readonly runtimeConfig?: Partial<RuntimeConfig>;
  /** A zombie instance: its heartbeat never renews the lease, so `expireLease` hands its step to another instance. */
  readonly zombie?: boolean;
}

export interface AgentsHarness {
  readonly runtime: Runtime;
  readonly agents: Agents;
  readonly sessions: AgentSessions;
  /** The Drizzle client of the harness's pool; the tests only read through it (and `expireLease`). */
  readonly db: Database;
  readonly fixture: FixtureFiles;
  /** Every record runtime and agents logged, in order. */
  readonly logs: readonly LogRecord[];
  /** Stops the workers, closes the MCP processes, then the pool — each also when the one before fails. */
  close(): Promise<void>;
}

/** Builds runtime + agents with the scripted model against the test database and starts them. */
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
  const agentsConfig = parseAgentsConfig(
    {
      AGENT_DEFAULT_MODEL: TEST_MODEL_DEFAULT,
      MCP_ACCESS_TABLE: JSON.stringify(options.access),
      MCP_CALL_TIMEOUT_MS: '90000',
      ...options.variables,
    },
    fixtureServers(fixture),
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
    modelPrices: TEST_MODEL_PRICES,
  });
  const agents = createAgents({
    database: database.db,
    runtime,
    logger,
    config: agentsConfig,
    turnClient: options.model.turnClient,
  });
  for (const definition of options.definitions ?? []) agents.definitions.register(definition);

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
    db: database.db,
    fixture,
    logs: sink.records,
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

/** The token ledger rows of an owner. */
export function ledgerRowsOf(db: Database, ownerId: string) {
  return db
    .select({ taskId: runtimeModelCalls.taskId, model: runtimeModelCalls.model, callId: runtimeModelCalls.callId })
    .from(runtimeModelCalls)
    .where(eq(runtimeModelCalls.ownerId, ownerId));
}

/** The audit rows of an agent's tool calls, by answer and position. */
export function toolCallRowsOf(db: Database, agentId: string) {
  return db
    .select()
    .from(agentToolCalls)
    .where(eq(agentToolCalls.taskId, agentId))
    .orderBy(asc(agentToolCalls.answerSeq), asc(agentToolCalls.position));
}

/**
 * Row versions (`xmin`) of everything the agents and the runtime keep about the given agents: their
 * `agent_sessions`, `agent_messages`, `agent_tool_calls` and `runtime_tasks` rows, one sorted line each
 * (`<table> <task id> [<key>] <version>`). Equal snapshots mean no row was written, added or removed.
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
    SELECT concat_ws(' ', 'call', task_id, call_id, xmin) FROM app.agent_tool_calls WHERE task_id IN (${ids})
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
