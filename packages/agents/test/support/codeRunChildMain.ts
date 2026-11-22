import {
  AGENT_TURN_CLIENT,
  EMBEDDING_CLIENT,
  parseAgentsConfig,
} from '@agent-os/agents';
import {
  createAccessGateDouble,
  createLibraryDouble,
  createScriptedEmbeddings,
  createScriptedModel,
  type ScriptedModel,
} from '@agent-os/agents/testing';
import { consoleSink, createLogger } from '@agent-os/common';
import { RUN_CODE_TOOL } from '@agent-os/contracts';
import { type ModelPrice, parseRuntimeConfig } from '@agent-os/runtime';
import { runtimeModules, serveHarness } from '@agent-os/runtime/testing';
import { Test } from '@nestjs/testing';
import {
  CHILD_MODEL,
  CHILD_SCENARIO_ENV,
  type ChildScenario,
  readRun,
  type ScenarioServers,
  writeRun,
} from './codeRunChild';
import { agentsModule } from './runtimeContext';

/**
 * Entry of the code-execution E2E-1 child process, run from source through `tsx`. It plays the API process: a Nest context of `DbModule`,
 * `RuntimeModule` and `AgentsModule` with the REAL code executor (`createCodeRunner`, the default of the package), the
 * scripted model and the MCP fixture servers the test registered in the database at its own fixture
 * process. It reads its environment — `DATABASE_URL`, the Runtime
 * settings (workers on, short reaper) and the scenario (`CODE_RUN_CHILD_SCENARIO`: the agents
 * settings and the run's server names) — and logs every record as a JSON line to the console, which the
 * harness parses. It creates no agents and registers no server or model provider: the test process does. IPC:
 * `{ kind: 'ready' }` once the workers run; `{ kind: 'stop' }` closes the context — the workers stop,
 * then the agents, then the pool — and exits 0. The test kills it from outside.
 */

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

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const logger = createLogger({
    sinks: [consoleSink()],
    secrets: [],
    minLevel: 'info',
  });
  const scenario = readScenario();
  const app = await Test.createTestingModule({
    imports: [
      ...runtimeModules(
        logger,
        connectionString,
        parseRuntimeConfig(process.env),
      ),
      agentsModule(parseAgentsConfig(scenario.variables), {
        // Every owner of these tests is active; the audit hook is not asserted in the child.
        access: createAccessGateDouble({
          servers: scenario.access,
          prices: CHILD_MODEL_PRICES,
          defaultChatModel: CHILD_MODEL,
        }),
        audit: async () => {},
        // Steps read the snapshot of their run from the task input; only the test process starts runs.
        library: createLibraryDouble(),
      }),
    ],
  })
    .overrideProvider(AGENT_TURN_CLIENT)
    .useValue(scenarioModel(scenario.servers).turnClient)
    // A child calls no embeddings; the double keeps the real provider client out of the test anyway.
    .overrideProvider(EMBEDDING_CLIENT)
    .useValue(createScriptedEmbeddings().client)
    .compile();
  // The registrations of `onModuleInit`, then the workers start.
  await app.init();

  serveHarness(app, logger, 'code-run child');
}

main().catch((error: unknown) => {
  createLogger({
    sinks: [consoleSink()],
    secrets: [],
    minLevel: 'error',
  }).error('code-run child failed', {
    error,
  });
  process.exit(1);
});
