import { createDatabase } from '@agent-os/db';
import {
  createEngine,
  deepResearchProcessV2,
  type EngineLogger,
  type StartInvestigationResult,
  type TokenCounter,
} from '@agent-os/engine';
import {
  type AttemptGuardResult,
  createRuntime,
  parseRuntimeConfig,
  type RuntimeLogger,
  type RuntimeTx,
  systemClock,
  type TaskContext,
  type TaskHandler,
  type TaskScheduler,
} from '@agent-os/runtime';
import { createSources, FIXTURE_SOURCE_ID, parseSourcesSettings, type SourcesLogger } from '@agent-os/sources';
// The probe forms are registered through the internal assembly `composeEngine` from the package's sources (ADR-0010);
// `tsconfig.child.json` compiles these sources together with this entry.
import { SHIPPED_RESULT_FORMS } from '../../src/agents/result-forms.js';
import { composeEngine } from '../../src/create-engine.js';
import { databaseUrl } from './database-url.js';
import { FIXTURE_ALLOWLIST, fixtureAdapter } from './fixtureHarness.js';
import { PROBE_FORMS } from './probe-forms.js';
import { createScriptedModel, type RecordedModelCall, type ScriptedStep } from './scriptedModel.js';
import { agentProbeConfig, PROBE_PROCESS_ID } from './test-configs.js';
import { turnInputCharacters } from './turnCount.js';

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
 * With the scenario's `processId` = `agent-probe` (agent-core E2E-1) the child loads the probe process as data and the
 * probe forms through `composeEngine` from the sources, the model answers by {@link agentProgram}, and the agent's
 * points are —
 * - `agent.before-reserve` at the `n`-th count of a turn's input, which comes right before the turn's reserve (K1);
 * - `agent.after-answer` when the double has produced lead's answer that asks `memory_write`, before the gateway gets
 *   it, i.e. after the reserve (K2);
 * - `agent.after-note` after the guarded write that stored the investigation's `n`-th note with its call's result (K3);
 * - `agent.after-propose` after `propose` of the `n`-th `agent.run` task returned, before the call records its id (K4);
 * - `agent.after-propose-failed` the same, once the database shows that task `failed` (K5);
 * - `agent.while-waiting` in helper's first model call, once the database shows lead `waiting` (K6);
 * - `agent.after-prologue` after the guarded write of recorder's prologue (K7);
 * - `agent.after-closure` after the guarded write of recorder's accepted closure, before its task ends (K8).
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
  /** `agent-probe` for the agent-core rows; the v2 process `deep-research` without it. */
  readonly processId?: string;
  /** The agent program's variant: helper's model is unavailable (K5); the whole tree without it. */
  readonly agentProgram?: 'helper-fails';
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
const CRASH_POINTS = [
  'before-propose',
  'worker-call',
  'engine.start.after-row',
  'agent.before-reserve',
  'agent.after-answer',
  'agent.after-note',
  'agent.after-propose',
  'agent.after-propose-failed',
  'agent.while-waiting',
  'agent.after-prologue',
  'agent.after-closure',
] as const;
type CrashPoint = (typeof CRASH_POINTS)[number];
const CRASH_AT_FORMAT = /^([a-z.-]+)(?::(\d+))?$/;
const AGENT_RUN_WORKFLOW = 'agent.run';
const AGENT_WORKFLOWS = new Set(['agent.root', AGENT_RUN_WORKFLOW]);
/** How often a crash point that waits for a row reads the database. */
const POLL_MS = 50;

/** The slice the step-1 sub-question reads: one page of 20 records, well inside the worker window. */
const SUBQUESTION_SLICE = {
  from: '2026-09-15T00:00:00.000Z',
  to: '2026-09-15T00:10:00.000Z',
  service: 'provider-adapter',
  pageSize: 20,
};

/** The engine's crash point of this process: `hit` counts its passes and exits; `at` names it, null when unset. */
interface Crash {
  readonly at: CrashPoint | null;
  readonly hit: (point: CrashPoint) => void;
}

/** The engine's crash point of this process, counting its passes; never set under `NODE_ENV=production`. */
function crashPoint(raw: string | undefined, nodeEnv: string | undefined): Crash {
  if (nodeEnv === 'production' || raw === undefined || raw === '') return { at: null, hit: () => undefined };
  const match = CRASH_AT_FORMAT.exec(raw);
  const point = match?.[1];
  if (match === null || !(CRASH_POINTS as readonly (string | undefined)[]).includes(point)) {
    throw new Error(`Invalid ENGINE_CRASH_AT "${raw}": expected <point>[:n] with a point of ${CRASH_POINTS.join(', ')}`);
  }
  const pass = match[2] === undefined ? 1 : Number(match[2]);
  if (pass < 1) throw new Error(`Invalid ENGINE_CRASH_AT "${raw}": the pass number starts at 1`);
  let passes = 0;
  return {
    at: point as CrashPoint,
    hit: (hit) => {
      if (hit !== point) return;
      passes += 1;
      if (passes === pass) process.exit(CRASH_EXIT_CODE);
    },
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

/**
 * The agent program of agent-core E2E-1, a function of the call as {@link program} is: the agent by its prompt marker,
 * the step by the number of tool results in the prompt. lead writes a note, calls helper and finishes; helper calls
 * recorder and finishes (in `helper-fails` its model is unavailable on every call); recorder finishes at once.
 */
function agentProgram(crash: Crash, variant: EngineChildScenario['agentProgram'], leadWaiting: () => Promise<void>) {
  const usage = { inputTokens: 1_000, outputTokens: 50 };
  const turn = (tool: string, args: unknown): ScriptedStep => ({ toolCalls: [{ tool, args }], usage });
  return (call: RecordedModelCall): ScriptedStep | undefined => {
    switch (call.agent) {
      case 'lead':
        if (call.toolResults === 0) {
          crash.hit('agent.after-answer');
          return turn('memory_write', { kind: 'note', text: 'lead note', refs: [] });
        }
        if (call.toolResults === 1) return turn('call_agent', { agent: 'helper', assignment: 'Have the result recorded.' });
        return turn('finish', { summary: 'lead done', refs: [] });
      case 'helper': {
        if (variant === 'helper-fails') return { providerError: { statusCode: 503 } };
        if (call.toolResults > 0) return turn('finish', { summary: 'helper done', refs: [] });
        const step = turn('call_agent', { agent: 'recorder', assignment: JSON.stringify({ task: 'the probe task' }) });
        if (crash.at !== 'agent.while-waiting') return step;
        return { ...step, holdUntil: leadWaiting().then(() => crash.hit('agent.while-waiting')) };
      }
      case 'recorder':
        return turn('finish', { note: 'recorded' });
      default:
        return undefined;
    }
  };
}

/**
 * One token per character, as the in-process harness counts: a role call by its instructions and messages, an agent
 * turn by everything it sends (test/support/turnCount.ts), so the probe's windows fit E2E-1 without a window step. The
 * count of a turn comes right before its reserve: the point `agent.before-reserve`.
 */
function characterCounter(crash: Crash): TokenCounter {
  return {
    countInputTokens: (request) =>
      Promise.resolve({
        outcome: 'counted',
        inputTokens: request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0),
      }),
    countTurnInputTokens: (request) => {
      crash.hit('agent.before-reserve');
      return Promise.resolve({ outcome: 'counted', inputTokens: turnInputCharacters(request) });
    },
  };
}

type Pool = ReturnType<typeof createDatabase>['pool'];

/** Waits until `check` holds over the database: a crash point that needs a row before the exit polls for it. */
async function untilRow(check: () => Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

async function countOf(pool: Pool, query: string, values: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(query, values);
  return rows[0]?.count ?? 0;
}

/**
 * The points after a guarded write of an agent task (K3, K7, K8): the write committed, and the database shows what the
 * point names. Only the configured point reads the database.
 */
function afterGuardedWrite(crash: Crash, pool: Pool) {
  let notesSeen = 0;
  return async (investigationId: string): Promise<void> => {
    switch (crash.at) {
      case 'agent.after-note': {
        const notes = await countOf(
          pool,
          'SELECT count(*)::int AS count FROM app.research_agent_memory WHERE investigation_id = $1',
          [investigationId],
        );
        for (; notesSeen < notes; notesSeen += 1) crash.hit('agent.after-note');
        return;
      }
      case 'agent.after-prologue': {
        const prologues = await countOf(
          pool,
          "SELECT count(*)::int AS count FROM app.research_agent_messages WHERE investigation_id = $1 AND kind = 'prologue'",
          [investigationId],
        );
        if (prologues > 0) crash.hit('agent.after-prologue');
        return;
      }
      case 'agent.after-closure': {
        const results = await countOf(
          pool,
          "SELECT count(*)::int AS count FROM app.research_agent_runs WHERE investigation_id = $1 AND agent_name = 'recorder' AND result IS NOT NULL",
          [investigationId],
        );
        if (results > 0) crash.hit('agent.after-closure');
        return;
      }
      default:
        return;
    }
  };
}

/** An agent handler with `after` awaited after each committed guarded write of its attempts; other handlers as they are. */
function observed(handler: TaskHandler, after: (investigationId: string) => Promise<void>): TaskHandler {
  if (!AGENT_WORKFLOWS.has(handler.workflowType)) return handler;
  return {
    ...handler,
    run: (ctx) => {
      function withAttemptGuard<T>(work: (tx: RuntimeTx) => Promise<T>): Promise<AttemptGuardResult<T>>;
      function withAttemptGuard<T>(
        work: (tx: RuntimeTx) => Promise<T>,
        options: { readonly requireActive: true },
      ): Promise<AttemptGuardResult<T, true>>;
      async function withAttemptGuard<T>(
        work: (tx: RuntimeTx) => Promise<T>,
        options?: { readonly requireActive: true },
      ): Promise<AttemptGuardResult<T, true>> {
        const result = options === undefined ? await ctx.withAttemptGuard(work) : await ctx.withAttemptGuard(work, options);
        if (result.outcome === 'committed') await after(ctx.investigationId);
        return result;
      }
      const watched = new Proxy(ctx, {
        get(target, property) {
          if (property === 'withAttemptGuard') return withAttemptGuard;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return handler.run(watched as TaskContext);
    },
  };
}

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
  const crash = crashPoint(process.env.ENGINE_CRASH_AT, process.env.NODE_ENV);
  const { hit } = crash;
  const agents = scenario.processId === PROBE_PROCESS_ID;
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
  /** After `propose` of an agent run's task: K4's point, and K5's once the database shows that task failed. */
  const agentProposed = async (taskId: string): Promise<void> => {
    hit('agent.after-propose');
    if (crash.at !== 'agent.after-propose-failed') return;
    await untilRow(async () => {
      const { rows } = await database.pool.query<{ status: string }>('SELECT status FROM app.research_tasks WHERE task_id = $1', [taskId]);
      return rows[0]?.status === 'failed';
    });
    hit('agent.after-propose-failed');
  };
  const scheduler: Pick<TaskScheduler, 'propose'> = {
    async propose(spec, requesterKey) {
      hit(spec.workflowType === CONTROLLER_WORKFLOW ? 'engine.start.after-row' : 'before-propose');
      const result = await runtime.scheduler.propose(spec, requesterKey);
      post({ kind: 'proposed', workflowType: spec.workflowType, outcome: result.outcome });
      if (spec.workflowType === AGENT_RUN_WORKFLOW && result.outcome !== 'rejected') await agentProposed(result.taskId);
      return result;
    },
  };
  const leadWaiting = () =>
    untilRow(
      async () =>
        (await countOf(
          database.pool,
          `SELECT count(*)::int AS count FROM app.research_tasks t
             JOIN app.research_investigations i ON i.investigation_id = t.investigation_id
            WHERE i.resource_id = $1 AND t.workflow_type = 'agent.root' AND t.status = 'waiting'`,
          [scenario.resourceId],
        )) > 0,
    );
  const after = afterGuardedWrite(crash, database.pool);
  const engineOptions = {
    database: database.db,
    runtime: {
      scheduler,
      investigations: runtime.investigations,
      evidence: runtime.evidence,
      handlers: { register: (handler: TaskHandler) => runtime.handlers.register(observed(handler, after)) },
      eventConsumers: runtime.eventConsumers,
    },
    sourceRegistry: sources.registry,
    connectedSources: [FIXTURE_SOURCE_ID],
    resolveModel: createScriptedModel({
      fallback: agents ? agentProgram(crash, scenario.agentProgram, leadWaiting) : program(hit),
    }).resolveModel,
    tokenCounter: characterCounter(crash),
    clock: systemClock,
    logger: consoleLogger,
  };
  const engine = agents
    ? composeEngine({ ...engineOptions, processes: [agentProbeConfig()] }, { resultForms: [...SHIPPED_RESULT_FORMS, ...PROBE_FORMS] })
    : createEngine({ ...engineOptions, processes: [deepResearchProcessV2] });
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
    processId: scenario.processId ?? 'deep-research',
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
