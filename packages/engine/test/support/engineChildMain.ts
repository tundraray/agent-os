import { createDatabase } from '@agent-os/db';
import {
  createEngine,
  deepResearchProcessV2,
  type EngineLogger,
  type StartInvestigationResult,
  type TokenCounter,
} from '@agent-os/engine';
import { createRuntime, parseRuntimeConfig, type RuntimeLogger, systemClock, type TaskScheduler } from '@agent-os/runtime';
import { createSources, FIXTURE_SOURCE_ID, parseSourcesSettings, type SourcesLogger } from '@agent-os/sources';
import { databaseUrl } from './database-url.js';
import { FIXTURE_ALLOWLIST, fixtureAdapter } from './fixtureHarness.js';
import { createScriptedModel, type RecordedModelCall, type ScriptedStep } from './scriptedModel.js';

/**
 * Entry of the engine child process (E2E-2), run only compiled (`pnpm --filter @agent-os/engine build:child` →
 * `dist/test-child/`). It is the assembly point of its test and reads only its environment: `DATABASE_URL`, Runtime
 * Settings with `RUNTIME_CRASH_AT`, Sources Settings with the test's `FIXTURE_FAULTS` and `FIXTURE_CALL_LOG`, the
 * scenario in {@link ENGINE_CHILD_SCENARIO_ENV} and the engine's own crash point in `ENGINE_CRASH_AT`. It builds
 * `createDatabase`, `createRuntime`, `createSources` with the fixture process and `createEngine` with the model double
 * and `connectedSources` = the fixture, from the packages' `dist` (imported by name), starts the workers and then
 * starts the scenario's investigation — every start with the same `launchKey`, as a user repeats a launch.
 *
 * The engine's crash points live here, in test code, never in `src` (rule 11 of the plan): `ENGINE_CRASH_AT=<point>[:n]`
 * (not read under `NODE_ENV=production`) ends the process with code 137 —
 * - `before-propose` before the `n`-th proposal of a step task (any type but `research.controller`), i.e. after the
 *   decision that proposes it was recorded (K1);
 * - `worker-call` inside the `n`-th call of the worker role, after its reservation was written (K2);
 * - `engine.start.after-row` when `startInvestigation` proposes the `research.controller` task for the `n`-th time,
 *   i.e. after it wrote the `research_engine_runs` row (K3, KD-9).
 *
 * IPC to the harness: `proposed` after every proposal the runtime answered, `started` once the start returned.
 * `{ kind: 'stop' }` stops the runtime, closes the sources and the pool and exits 0.
 */

/**
 * The variable that carries the scenario. A type, so the harness names it without importing this module, whose import
 * would start a child in the test process.
 */
export type EngineChildScenarioEnv = 'ENGINE_CHILD_SCENARIO';
const ENGINE_CHILD_SCENARIO_ENV: EngineChildScenarioEnv = 'ENGINE_CHILD_SCENARIO';

/** What the child starts, as JSON in {@link ENGINE_CHILD_SCENARIO_ENV}. */
export interface EngineChildScenario {
  readonly resourceId: string;
  readonly threadId: string;
  readonly launchKey: string;
  readonly query: string;
}

/** Messages of the child to the harness (IPC). */
export type EngineChildMessage =
  | { readonly kind: 'proposed'; readonly workflowType: string; readonly outcome: string }
  | { readonly kind: 'started'; readonly outcome: StartInvestigationResult['outcome'] };

/** Messages of the harness to the child (IPC). */
export interface StopMessage {
  readonly kind: 'stop';
}

const CONTROLLER_WORKFLOW = 'research.controller';
/**
 * Exit code of a crash: the code of a process killed by SIGKILL, as `RUNTIME_CRASH_AT` exits. A type, so the harness
 * shares it without importing this module.
 */
export type CrashExitCode = 137;
const CRASH_EXIT_CODE: CrashExitCode = 137;
const CRASH_POINTS = ['before-propose', 'worker-call', 'engine.start.after-row'] as const;
type CrashPoint = (typeof CRASH_POINTS)[number];
const CRASH_AT_FORMAT = /^([a-z.-]+)(?::(\d+))?$/;

/** The slice the step-1 sub-question reads: one page of 20 records, well inside the worker window. */
const SUBQUESTION_SLICE = {
  from: '2026-09-15T00:00:00.000Z',
  to: '2026-09-15T00:10:00.000Z',
  service: 'provider-adapter',
  pageSize: 20,
};

/** The engine's crash point of this process, counting its passes; never set under `NODE_ENV=production`. */
function crashPoint(raw: string | undefined, nodeEnv: string | undefined): (point: CrashPoint) => void {
  if (nodeEnv === 'production' || raw === undefined || raw === '') return () => undefined;
  const match = CRASH_AT_FORMAT.exec(raw);
  const point = match?.[1];
  if (match === null || !(CRASH_POINTS as readonly (string | undefined)[]).includes(point)) {
    throw new Error(`Invalid ENGINE_CRASH_AT "${raw}": expected <point>[:n] with a point of ${CRASH_POINTS.join(', ')}`);
  }
  const pass = match[2] === undefined ? 1 : Number(match[2]);
  if (pass < 1) throw new Error(`Invalid ENGINE_CRASH_AT "${raw}": the pass number starts at 1`);
  let passes = 0;
  return (hit) => {
    if (hit !== point) return;
    passes += 1;
    if (passes === pass) process.exit(CRASH_EXIT_CODE);
  };
}

function readScenario(): EngineChildScenario {
  const raw = process.env[ENGINE_CHILD_SCENARIO_ENV];
  if (!raw) throw new Error(`${ENGINE_CHILD_SCENARIO_ENV} is not set`);
  return JSON.parse(raw) as EngineChildScenario;
}

/** Messages on their way to the harness; the stop waits for them, so none is lost by the exit. */
const sending = new Set<Promise<void>>();

/**
 * Sends a message without waiting for it: the caller goes on in the same turn of the event loop, so a crash point
 * right after is reached before any other work of the process runs (a dispatcher claim, a source call).
 */
function post(message: EngineChildMessage): void {
  const sent = new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('The child process has no IPC channel'));
      return;
    }
    process.send(message, undefined, undefined, (error) => (error ? reject(error) : resolve()));
  });
  sending.add(sent);
  sent.then(
    () => sending.delete(sent),
    (error: unknown) => console.error('Sending a message to the harness failed', error),
  );
}

/**
 * The model double's program, a function of the call, so a restarted process answers whatever call comes next: the
 * controller analyses one sub-question first and proposes the answer once a `research.analyze` task is in its input;
 * the worker states one claim without evidence; the synthesis answers with no claims.
 */
function program(hit: (point: CrashPoint) => void) {
  return (call: RecordedModelCall): ScriptedStep | undefined => {
    switch (call.role) {
      case 'controller':
        return call.user.includes('research.analyze')
          ? { output: { kind: 'proposeAnswer', rationale: 'the sub-question is analysed' } }
          : {
              output: {
                kind: 'requestAnalysis',
                rationale: 'analyse the provider adapter errors',
                subquestions: [
                  {
                    text: 'Which errors did the provider adapter log?',
                    sourceId: FIXTURE_SOURCE_ID,
                    toolName: 'search_logs',
                    args: SUBQUESTION_SLICE,
                    completeness: 'sample',
                  },
                ],
              },
            };
      case 'worker':
        hit('worker-call');
        return { output: { claims: [{ text: 'The provider adapter logged errors.', atoms: [], pointer: [] }] } };
      case 'synthesis':
        return { output: { outcome: 'answered', summaryClaimIds: [], claims: [] } };
      default:
        return undefined;
    }
  };
}

/** One token per character, as the in-process harness counts. */
const characterCounter: TokenCounter = {
  countInputTokens: (request) =>
    Promise.resolve({
      outcome: 'counted',
      inputTokens: request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0),
    }),
};

/** Log lines go to the output the harness keeps for a failure message. */
const consoleLogger: EngineLogger & RuntimeLogger = {
  log: (message, fields) => console.log(message, JSON.stringify(fields ?? {})),
  warn: (message, fields) => console.warn(message, JSON.stringify(fields ?? {})),
  error: (message, fields) => console.error(message, JSON.stringify(fields ?? {})),
};
const sourcesLogger: SourcesLogger = {
  debug: () => undefined,
  warn: (message, fields) => console.warn(message, JSON.stringify(fields)),
  error: (message, fields) => console.error(message, JSON.stringify(fields)),
};

async function main(): Promise<{ close(): Promise<void> }> {
  const scenario = readScenario();
  const hit = crashPoint(process.env.ENGINE_CRASH_AT, process.env.NODE_ENV);
  // The environment is authoritative here: the child is the composition root of its runtime.
  const config = parseRuntimeConfig(process.env);
  const database = createDatabase({ connectionString: databaseUrl(), poolMax: config.dbPoolMax });
  const runtime = createRuntime({
    database,
    config,
    threads: {
      async withOwnedThread(threadId, resourceId, fn) {
        if (threadId !== scenario.threadId || resourceId !== scenario.resourceId) {
          throw new Error(`Thread ${threadId} of ${resourceId} not found`);
        }
        return fn();
      },
    },
    logger: consoleLogger,
    clock: systemClock,
  });
  const settings = parseSourcesSettings(process.env);
  const sources = createSources({
    handlers: runtime.handlers,
    adapters: [fixtureAdapter(settings, sourcesLogger)],
    allowlist: FIXTURE_ALLOWLIST,
    settings,
    clock: systemClock,
    logger: sourcesLogger,
  });
  const scheduler: Pick<TaskScheduler, 'propose'> = {
    async propose(spec, requesterKey) {
      hit(spec.workflowType === CONTROLLER_WORKFLOW ? 'engine.start.after-row' : 'before-propose');
      const result = await runtime.scheduler.propose(spec, requesterKey);
      post({ kind: 'proposed', workflowType: spec.workflowType, outcome: result.outcome });
      return result;
    },
  };
  const engine = createEngine({
    database: database.db,
    runtime: {
      scheduler,
      investigations: runtime.investigations,
      evidence: runtime.evidence,
      handlers: runtime.handlers,
      eventConsumers: runtime.eventConsumers,
    },
    sourceRegistry: sources.registry,
    connectedSources: [FIXTURE_SOURCE_ID],
    processes: [deepResearchProcessV2],
    resolveModel: createScriptedModel({ fallback: program(hit) }).resolveModel,
    tokenCounter: characterCounter,
    clock: systemClock,
    logger: consoleLogger,
  });
  const close = async (): Promise<void> => {
    try {
      await runtime.stop();
      await sources.close();
    } finally {
      await database.close();
    }
  };

  runtime.start();
  const started = await engine.startInvestigation({
    resourceId: scenario.resourceId,
    threadId: scenario.threadId,
    query: scenario.query,
    processId: 'deep-research',
    launchKey: scenario.launchKey,
  });
  post({ kind: 'started', outcome: started.outcome });
  return { close };
}

const ready = main();
// The stop waits for the start and for every message, so all of them leave the process before the exit.
process.on('message', (message: StopMessage) => {
  if (message.kind !== 'stop') return;
  ready
    .then((child) => child.close())
    .then(() => Promise.all(sending))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Closing the engine child failed', error);
        process.exit(1);
      },
    );
});
ready.catch((error: unknown) => {
  console.error('Engine child failed', error);
  process.exit(1);
});
