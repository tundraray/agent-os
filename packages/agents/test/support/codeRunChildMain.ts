import { createAgents, parseAgentsConfig } from '@agent-os/agents';
import {
  createAccessGateDouble,
  createLibraryDouble,
  createScriptedModel,
  type ScriptedModel,
} from '@agent-os/agents/testing';
import { consoleSink, createLogger } from '@agent-os/common';
import { RUN_CODE_TOOL } from '@agent-os/contracts';
import { createDatabase } from '@agent-os/db';
import { createRuntime, type ModelPrice, parseRuntimeConfig, systemClock } from '@agent-os/runtime';
import {
  CHILD_MODEL,
  CHILD_SCENARIO_ENV,
  type ChildScenario,
  readRun,
  type ScenarioServers,
  writeRun,
} from './codeRunChild.js';

/**
 * Entry of the code-execution E2E-1 child process, run only compiled (`pnpm --filter @agent-os/agents
 * build:child` → `dist/test-child/`). It plays the API process: the composition root of `createRuntime`
 * + `createAgents` with the REAL code executor (`createCodeRunner`, the default of `createAgents`), the
 * scripted model and the MCP fixture servers the test registered in the database at its own fixture
 * process, all from the packages' built `dist`. It reads its environment — `DATABASE_URL`, the Runtime
 * settings (workers on, short lease and reaper) and the scenario (`CODE_RUN_CHILD_SCENARIO`: the agents
 * settings and the run's server names) — and logs every record as a JSON line to the console, which the
 * harness parses. It creates no agents and registers no server: the test process does. IPC:
 * `{ kind: 'ready' }` once the workers run; `{ kind: 'stop' }` stops the workers, the agents and the
 * pool, and exits 0. The test kills it from outside.
 */

/** Messages of the child to the harness. */
export type ChildMessage = { kind: 'ready' };
/** Messages of the harness to the child. */
export type HarnessMessage = { kind: 'stop' };

/** The catalogue of the child: {@link CHILD_MODEL} priced as in `agentsHarness.ts`, input 1, output 5 USD per million tokens. */
const CHILD_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  [CHILD_MODEL]: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.125,
  },
};

function readScenario(): ChildScenario {
  const raw = process.env[CHILD_SCENARIO_ENV];
  if (!raw) throw new Error(`${CHILD_SCENARIO_ENV} is not set`);
  return JSON.parse(raw) as ChildScenario;
}

/**
 * The model of every run of the scenario, computed from the input so a fresh process continues where
 * the killed one stopped: no tool result yet → the `run_code` call; a tool result → the report.
 */
function scenarioModel(servers: ScenarioServers): ScriptedModel {
  const model = createScriptedModel();
  for (const run of [readRun(servers), writeRun(servers)]) {
    model.script({ task: run.task }, [], {
      thereafter: (messages) =>
        messages.some((message) => message.role === 'tool')
          ? { text: run.report }
          : { calls: [{ tool: RUN_CODE_TOOL, args: run.args }] },
    });
  }
  return model;
}

function send(message: ChildMessage): void {
  if (!process.send) throw new Error('The child process has no IPC channel');
  process.send(message);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const scenario = readScenario();
  const runtimeConfig = parseRuntimeConfig(process.env);
  const agentsConfig = parseAgentsConfig(scenario.variables);
  const logger = createLogger({ sinks: [consoleSink()], secrets: [], minLevel: 'info' });
  const database = createDatabase({ connectionString, poolMax: runtimeConfig.dbPoolMax });
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
    turnClient: scenarioModel(scenario.servers).turnClient,
    // Every owner of these tests is active; the audit hook is not asserted in the child.
    access: createAccessGateDouble({ servers: scenario.access, prices: CHILD_MODEL_PRICES }),
    audit: async () => {},
    // Steps read the snapshot of their run from the task input; only the test process starts runs.
    library: createLibraryDouble(),
  });
  await agents.start();

  process.on('message', (message: HarnessMessage) => {
    if (message.kind !== 'stop') return;
    runtime
      .stop()
      .finally(() => agents.stop())
      .finally(() => database.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('code-run child stop failed', { error });
          process.exit(1);
        },
      );
  });

  runtime.start();
  send({ kind: 'ready' });
}

main().catch((error: unknown) => {
  createLogger({ sinks: [consoleSink()], secrets: [], minLevel: 'error' }).error('code-run child failed', {
    error,
  });
  process.exit(1);
});
