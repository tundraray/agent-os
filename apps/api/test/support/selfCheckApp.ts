import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  type DatabaseConnection,
  researchInvestigations,
  researchTasks,
} from '@agent-os/db';
import {
  createEngine,
  type Engine,
  type ResolveModel,
  type RoleModel,
} from '@agent-os/engine';
import {
  DATASET_VERSIONS,
  type DatasetVersion,
  fixtureServerPath,
} from '@agent-os/mcp-fixture';
import {
  type CancelTimer,
  type Clock,
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
  type ThreadOwnership,
} from '@agent-os/runtime';
import {
  createSources,
  FIXTURE_SOURCE_ID,
  FixtureSourceAdapter,
  parseSourcesSettings,
} from '@agent-os/sources';
import { MockLanguageModelV4 } from 'ai/test';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  createSelfCheckProgram,
  type CreateSelfCheckProgramResult,
  type SelfCheckPorts,
  type SelfCheckProgram,
} from '../../src/self-check/program.js';
import { REPORT_FILE_NAME } from '../../src/self-check/result/report.js';
import { RESULT_FILE_NAME } from '../../src/self-check/result/run-result.js';
import type { ScenarioAssembly } from '../../src/self-check/scenario-assembly.js';
import type { SelfCheckLogger } from '../../src/self-check/scenario-assembly.js';
import { SOURCES_ALLOWLIST } from '../../src/sources/sources.config.js';
import { mainDatabaseUrl } from './selfCheckDb.js';
import {
  createSelfCheckModels,
  type SelfCheckModels,
} from './selfCheckModels.js';

/**
 * The common assembly of the self-check integration file (design-self-check.md, Test Strategy): the program's ports
 * with the doubles — the scripted models behind `resolveModel` and the token counter, the program clock — and
 * everything else real: `createSelfCheckProgram` over the file's `_self_check` database, the runtime with its workers,
 * the fixture process on the scenario, Postgres. Each test builds its own app, so it gets its own report directory and
 * fixture call log under a temp dir; the database is the file's (`selfCheckDb.ts`).
 *
 * The program the app starts is the real one with one observation added: `assembleScenario` tells the models double
 * which scenario it assembles before delegating, so the scripted roles answer from that scenario's key (the program
 * runs scenarios one after another).
 *
 * An app can also stand for a run that fell (UC-E9): {@link SelfCheckApp.holdModelCalls} and
 * {@link SelfCheckApp.drop} leave its program, runtime and fixture as a killed process leaves them in the database —
 * tasks queued and in work — while nothing of it acts any more. Only {@link SelfCheckApp.close} releases them.
 */

/**
 * The program clock: the system clock moved by `offsetMs` (the 10-minute margin past the controller's deadline), with
 * an optional `timerDelay` that maps the delay of every timer the program, its runtime, sources and engine set (the
 * 5-second poll). A test that changes either sets it back before it ends.
 */
export interface SelfCheckClock extends Clock {
  offsetMs: number;
  timerDelay: ((ms: number) => number) | undefined;
}

/** The program clock with the switch {@link SelfCheckApp.drop} uses: a stopped clock fires no timer. */
interface StoppableClock extends SelfCheckClock {
  /** Cancels every pending timer; until {@link resume}, a new timer is never armed. */
  stop(): void;
  resume(): void;
}

function selfCheckClock(base: Clock): StoppableClock {
  const pending = new Set<CancelTimer>();
  let stopped = false;
  const clock: StoppableClock = {
    offsetMs: 0,
    timerDelay: undefined,
    now: () => new Date(base.now().getTime() + clock.offsetMs),
    random: () => base.random(),
    setTimer: (ms, callback) => {
      if (stopped) return () => undefined;
      const cancel = base.setTimer(clock.timerDelay?.(ms) ?? ms, () => {
        pending.delete(cancel);
        callback();
      });
      pending.add(cancel);
      return () => {
        pending.delete(cancel);
        cancel();
      };
    },
    stop: () => {
      stopped = true;
      for (const cancel of pending) cancel();
      pending.clear();
    },
    resume: () => {
      stopped = false;
    },
  };
  return clock;
}

/**
 * `resolveModel` of the app: the models double's model, whose answer is withheld — the call recorded by the double,
 * its promise never settled — once `held()` is true, as a provider that stopped answering.
 */
function holdingResolveModel(
  resolveModel: ResolveModel,
  held: () => boolean,
): ResolveModel {
  const models = new Map<string, RoleModel>();
  return (modelId) => {
    const existing = models.get(modelId);
    if (existing !== undefined) return existing;
    const scripted = resolveModel(modelId);
    if (!(scripted instanceof MockLanguageModelV4)) {
      throw new Error(`selfCheckApp: model ${modelId} is not a scripted one`);
    }
    const model = new MockLanguageModelV4({
      provider: scripted.provider,
      modelId,
      doGenerate: async (options) => {
        const answer = await scripted.doGenerate(options);
        return held() ? new Promise<typeof answer>(() => undefined) : answer;
      },
    });
    models.set(modelId, model);
    return model;
  };
}

/** An employee's investigation saved in the main database by {@link SelfCheckApp.saveEmployeeInvestigation}. */
export interface EmployeeInvestigation {
  readonly investigationId: string;
  /** The employee: `e2e-<uuid>`, unique per investigation. */
  readonly resourceId: string;
  readonly threadId: string;
}

export interface EmployeeInvestigationRequest {
  readonly question: string;
  /** The configuration the investigation runs with, as data: it is frozen in its run row. */
  readonly processConfig: unknown;
  /**
   * The dataset the fixture serves (`v1`, `v2`), the investigation run to its end by the real engine; or `legacy` — an
   * investigation as one from before the slice was recorded: the fixture cannot report its slice (the start records
   * it empty) and the investigation is cancelled before any task runs, so it has no evidence page either.
   */
  readonly dataset: DatasetVersion | 'legacy';
}

/** One recorded log call of the program: identifiers only (plan rule 12), so a test may read them all. */
export type SelfCheckLogLine = [
  level: keyof SelfCheckLogger,
  message: string,
  fields: Readonly<Record<string, unknown>> | undefined,
];

/** One line of the fixture call log: only `tools/call`, written before the call is processed. */
export interface FixtureCallLogLine {
  readonly seq: number;
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrence: number;
  readonly mode: string | null;
  readonly pid: number;
}

export interface SelfCheckAppOptions {
  /** `SELF_CHECK_DATABASE_URL`: the file's database from `SelfCheckDatabases.create`, or one the guard must refuse. */
  readonly selfCheckDatabaseUrl: string | undefined;
  /** `DATABASE_URL`; the main database of the suite by default. */
  readonly mainDatabaseUrl?: string;
  /** Runtime Settings over the test defaults: workers on, 2 slots, 50 ms poll, pool of 4. */
  readonly runtime?: Partial<RuntimeConfig>;
  /** The models double; a new one by default. A test that restarts the program passes the same one. */
  readonly models?: SelfCheckModels;
}

export interface SelfCheckApp {
  /** The ports `start` hands to `createSelfCheckProgram`. */
  readonly ports: SelfCheckPorts;
  readonly models: SelfCheckModels;
  readonly clock: SelfCheckClock;
  /** This app's own report directory. */
  readonly reportsDir: string;
  /** Every log call of the program, its runtime, sources and engine, in order. */
  readonly logs: SelfCheckLogLine[];
  /** The fixture call log in file order — the independent counter of `tools/call`; empty before the first call. */
  readCallLog(): FixtureCallLogLine[];
  /**
   * The program's start (guard, migrations, leftovers) over the ports: a refusal as the program returns it, or the
   * program with `assembleScenario` observed by the models double. A started program is closed by {@link close}, and
   * so is every scenario assembly its caller has not closed.
   */
  start(): Promise<CreateSelfCheckProgramResult>;
  /**
   * The scenario (`<set>/<scenario>`) whose script the scripted roles follow on a dataset version (`v1`, `v2`): an
   * employee's investigation has no key of its own, so its roles read and state what that scenario's behaviour says.
   */
  scriptDatasetsAs(scenario: string): void;
  /**
   * From now on the program's assembly for `requested` starts the fixture on `served` instead — a fixture that no
   * longer serves the slice it is asked for (UC-E3); `null` undoes it.
   */
  serveInstead(requested: string, served: string | null): void;
  /**
   * An employee's investigation in the main database, made by the real engine and runtime on the real fixture with the
   * scripted models: started for a new `e2e-` owner through `Engine.startInvestigation`, waited for until it is no
   * longer running and has no task left, then its assembly closed. Setup only: this and the two changes below are the
   * only writes of the file to the main database, each to the test's own investigation, and a test takes its snapshot
   * of the main database after them.
   */
  saveEmployeeInvestigation(
    request: EmployeeInvestigationRequest,
  ): Promise<EmployeeInvestigation>;
  /**
   * The employee deletes the conversation of a saved investigation: its investigations go from the main database with
   * every research row by the cascade, as the server's thread purge removes them (UC-E10, the original is gone).
   */
  deleteEmployeeConversation(
    investigation: EmployeeInvestigation,
  ): Promise<void>;
  /** Moves the creation of a saved investigation `days` back on the main database's clock (an original past the term). */
  ageEmployeeInvestigation(
    investigation: EmployeeInvestigation,
    days: number,
  ): Promise<void>;
  /** From now on no model call of this app gets an answer: the task in a model call stays in work. */
  holdModelCalls(): void;
  /**
   * Drops the app's programs without closing them, as a killed process: from now on no timer of the program clock
   * fires, so the runtime claims, heartbeats, relays and reaps nothing more, and nothing polls. Rows stay as they are
   * and leases run out; the pools and the fixture process stay open until {@link close}.
   */
  drop(): void;
  /** Closes every scenario assembly left open and every program started, then removes the temp directory. */
  close(): Promise<void>;
}

export function createSelfCheckApp(options: SelfCheckAppOptions): SelfCheckApp {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-self-check-'));
  const reportsDir = join(dir, 'reports');
  const callLogPath = join(dir, 'fixture-calls.jsonl');
  const models = options.models ?? createSelfCheckModels();
  const clock = selfCheckClock(systemClock);
  let holding = false;
  const logs: SelfCheckLogLine[] = [];
  const record =
    (level: keyof SelfCheckLogger) =>
    (message: string, fields?: Readonly<Record<string, unknown>>) => {
      logs.push([level, message, fields]);
    };
  const runtime: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 2,
    pollMs: 50,
    dbPoolMax: 4,
    ...options.runtime,
  };
  const ports: SelfCheckPorts = {
    selfCheckDatabaseUrl: options.selfCheckDatabaseUrl,
    mainDatabaseUrl: options.mainDatabaseUrl ?? mainDatabaseUrl(),
    reportsDir,
    clock,
    resolveModel: holdingResolveModel(models.resolveModel, () => holding),
    tokenCounter: models.tokenCounter,
    logger: {
      debug: record('debug'),
      log: record('log'),
      warn: record('warn'),
      error: record('error'),
    },
    runtime,
    sourcesVariables: {
      SOURCE_CALL_TIMEOUT_MS: '30000',
      SOURCE_RETRY_BASE_MS: '10',
      SOURCE_RETRY_CAP_MS: '50',
      FIXTURE_CALL_LOG: callLogPath,
    },
  };
  const started: SelfCheckProgram[] = [];
  const openAssemblies = new Set<ScenarioAssembly>();
  let datasetScript: string | null = null;
  const substitutes = new Map<string, string>();

  /** What the scripted roles answer from while `served` is assembled: a dataset follows its script. */
  const scriptOf = (served: string): string =>
    isDatasetVersion(served) && datasetScript !== null ? datasetScript : served;

  /** The assembly with its close recorded, so `close` of the app closes only what its caller left open. */
  const tracked = (assembly: ScenarioAssembly): ScenarioAssembly => {
    const observed: ScenarioAssembly = {
      ...assembly,
      async close() {
        if (!openAssemblies.delete(observed)) return;
        await assembly.close();
      },
    };
    openAssemblies.add(observed);
    return observed;
  };

  return {
    ports,
    models,
    clock,
    reportsDir,
    logs,
    readCallLog() {
      if (!existsSync(callLogPath)) return [];
      return readFileSync(callLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FixtureCallLogLine);
    },
    async start() {
      const created = await createSelfCheckProgram(ports);
      if (!created.ok) return created;
      const { program } = created;
      const observed: SelfCheckProgram = {
        ...program,
        assembleScenario: async (request) => {
          const served = substitutes.get(request.scenario) ?? request.scenario;
          models.assembling(scriptOf(served));
          return tracked(
            await program.assembleScenario({ ...request, scenario: served }),
          );
        },
      };
      started.push(observed);
      return { ok: true, program: observed };
    },
    scriptDatasetsAs(scenario) {
      datasetScript = scenario;
    },
    serveInstead(requested, served) {
      if (served === null) substitutes.delete(requested);
      else substitutes.set(requested, served);
    },
    saveEmployeeInvestigation(request) {
      if (request.dataset !== 'legacy') {
        models.assembling(scriptOf(request.dataset));
      }
      return saveEmployeeInvestigation({ ports, runtime }, request);
    },
    deleteEmployeeConversation({ threadId, resourceId }) {
      return inMainDatabase(ports, async (db) => {
        await db
          .delete(researchInvestigations)
          .where(
            and(
              eq(researchInvestigations.threadId, threadId),
              eq(researchInvestigations.resourceId, resourceId),
            ),
          );
      });
    },
    ageEmployeeInvestigation({ investigationId, resourceId }, days) {
      return inMainDatabase(ports, async (db) => {
        await db
          .update(researchInvestigations)
          .set({ createdAt: sql`now() - make_interval(days => ${days})` })
          .where(
            and(
              eq(researchInvestigations.investigationId, investigationId),
              eq(researchInvestigations.resourceId, resourceId),
            ),
          );
      });
    },
    holdModelCalls() {
      holding = true;
    },
    drop() {
      clock.stop();
    },
    async close() {
      // A dropped runtime stops only on a running clock: its shutdown waits for the grace timer.
      clock.resume();
      try {
        for (const assembly of openAssemblies) await assembly.close();
        for (const program of started.splice(0)) await program.close();
      } finally {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  };
}

const isDatasetVersion = (value: string): value is DatasetVersion =>
  DATASET_VERSIONS.some((version) => version === value);

// ---------------------------------------------------------------------------------------------
// Employee investigations in the main database
// ---------------------------------------------------------------------------------------------

/** The server's ownership as far as the engine sees it: the employee owns the conversation it names. */
const employeeThreads: ThreadOwnership = {
  withOwnedThread: (_threadId, _resourceId, fn) => fn(),
};

/** A scenario of no set: the fixture process refuses to start, so its slice cannot be read (a legacy investigation). */
const NO_SLICE_SCENARIO = 'legacy/no-slice';
const EMPLOYEE_POLL_MS = 50;
const EMPLOYEE_WAIT_MS = 120_000;
const UNFINISHED_TASK_STATUSES = ['queued', 'waiting', 'running'];

interface EmployeeAssembly {
  readonly database: DatabaseConnection;
  readonly runtime: Runtime;
  readonly engine: Engine;
}

/**
 * The assembly the server makes for an employee's investigation, over the main database: runtime, fixture source and
 * engine with the investigation's configuration. A legacy investigation gets no workers, so none of its tasks runs.
 */
async function saveEmployeeInvestigation(
  context: { readonly ports: SelfCheckPorts; readonly runtime: RuntimeConfig },
  request: EmployeeInvestigationRequest,
): Promise<EmployeeInvestigation> {
  const { ports } = context;
  const legacy = request.dataset === 'legacy';
  if (ports.mainDatabaseUrl === undefined) {
    throw new Error('selfCheckApp: no main database to save into');
  }
  const database = createDatabase({
    connectionString: ports.mainDatabaseUrl,
    poolMax: context.runtime.dbPoolMax,
  });
  const runtime = createRuntime({
    database,
    config: { ...context.runtime, workers: !legacy },
    threads: employeeThreads,
    logger: ports.logger,
    clock: ports.clock,
  });
  const settings = parseSourcesSettings({
    SOURCE_CALL_TIMEOUT_MS: '30000',
    SOURCE_RETRY_BASE_MS: '10',
    SOURCE_RETRY_CAP_MS: '50',
    ...(legacy
      ? { FIXTURE_SCENARIO: NO_SLICE_SCENARIO }
      : { FIXTURE_DATASET: request.dataset }),
  });
  const sources = createSources({
    handlers: runtime.handlers,
    adapters: [
      new FixtureSourceAdapter({
        serverPath: fixtureServerPath,
        settings,
        logger: ports.logger,
      }),
    ],
    allowlist: SOURCES_ALLOWLIST,
    settings,
    clock: ports.clock,
    logger: ports.logger,
  });
  try {
    const { handlers, eventConsumers, scheduler, investigations, evidence } =
      runtime;
    const engine = createEngine({
      database: database.db,
      runtime: {
        handlers,
        eventConsumers,
        scheduler,
        investigations,
        evidence,
      },
      sourceRegistry: sources.registry,
      connectedSources: [FIXTURE_SOURCE_ID],
      processes: [request.processConfig],
      resolveModel: ports.resolveModel,
      tokenCounter: ports.tokenCounter,
      clock: ports.clock,
      logger: ports.logger,
    });
    runtime.start();
    const { processId, version } = request.processConfig as {
      readonly processId: string;
      readonly version: number;
    };
    const owned = {
      resourceId: `e2e-${randomUUID()}`,
      threadId: `e2e-thread-${randomUUID()}`,
    };
    const start = await engine.startInvestigation({
      ...owned,
      query: request.question,
      processId,
      version,
      launchKey: randomUUID(),
    });
    if (start.outcome === 'rejected') {
      throw new Error(
        `selfCheckApp: the employee investigation was refused: ${start.code}`,
      );
    }
    const saved = { ...owned, investigationId: start.investigationId };
    if (legacy) {
      await investigations.cancel(saved.investigationId, saved.resourceId);
    }
    await settle({ database, runtime, engine }, saved);
    return saved;
  } finally {
    await runtime.stop();
    try {
      await sources.close();
    } finally {
      await database.close();
    }
  }
}

/** Runs `change` over a connection of its own to the main database, closed after it. */
async function inMainDatabase(
  ports: SelfCheckPorts,
  change: (db: DatabaseConnection['db']) => Promise<void>,
): Promise<void> {
  if (ports.mainDatabaseUrl === undefined) {
    throw new Error('selfCheckApp: no main database to change');
  }
  const database = createDatabase({
    connectionString: ports.mainDatabaseUrl,
    poolMax: 1,
  });
  try {
    await change(database.db);
  } finally {
    await database.close();
  }
}

/** Waits until the investigation no longer runs, cancels what it left, and waits until no task of it is left. */
async function settle(
  assembly: EmployeeAssembly,
  saved: EmployeeInvestigation,
): Promise<void> {
  const { investigationId, resourceId } = saved;
  await pollUntil(`${investigationId} ends`, async () => {
    const read = await assembly.engine.readInvestigation({
      investigationId,
      resourceId,
    });
    if (read.outcome !== 'found') {
      throw new Error(`selfCheckApp: ${investigationId} not found`);
    }
    return read.view.status !== 'running';
  });
  await assembly.runtime.investigations.cancel(investigationId, resourceId);
  await pollUntil(`no task of ${investigationId} left`, async () => {
    const [row] = await assembly.database.db
      .select({ unfinished: count() })
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.investigationId, investigationId),
          inArray(researchTasks.status, UNFINISHED_TASK_STATUSES),
        ),
      );
    return (row?.unfinished ?? 0) === 0;
  });
}

async function pollUntil(
  what: string,
  condition: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + EMPLOYEE_WAIT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`selfCheckApp: timed out waiting: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, EMPLOYEE_POLL_MS));
  }
}

// ---------------------------------------------------------------------------------------------
// Run directories
// ---------------------------------------------------------------------------------------------

/** A run directory as the program left it. */
export interface RunDir {
  readonly path: string;
  /** The names of its files. */
  readonly files: readonly string[];
  /** The parsed result file; a test checks it against the `RunResult` contract. */
  readonly result: unknown;
  /** The Markdown report. */
  readonly report: string;
}

/** The run directories under `reportsDir`, in name order. */
export function runDirsOf(reportsDir: string): string[] {
  if (!existsSync(reportsDir)) return [];
  return readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(reportsDir, entry.name))
    .sort();
}

/** Reads a run directory: its files, the parsed result file and the report under the names the `run` command writes; throws when either is missing. */
export function runDir(path: string): RunDir {
  return {
    path,
    files: readdirSync(path).sort(),
    result: JSON.parse(readFileSync(join(path, RESULT_FILE_NAME), 'utf8')),
    report: readFileSync(join(path, REPORT_FILE_NAME), 'utf8'),
  };
}
