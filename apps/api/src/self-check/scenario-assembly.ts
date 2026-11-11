import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import {
  type ClaimAssessmentAgent,
  claimAssessmentAgent,
  createEngine,
  type Engine,
  type ResolveModel,
  type TokenCounter,
} from '@agent-os/engine';
import {
  DATASET_VERSIONS,
  type DatasetVersion,
  fixtureServerPath,
} from '@agent-os/mcp-fixture';
import {
  type Clock,
  createRuntime,
  type Runtime,
  type RuntimeConfig,
  type ThreadOwnership,
} from '@agent-os/runtime';
import {
  BACKOFFICE_SOURCE_ID,
  BackofficeSourceAdapter,
  createSources,
  FIXTURE_SOURCE_ID,
  FixtureSourceAdapter,
  parseSourcesSettings,
  type Sources,
  type SourcesEnv,
  type SourcesLogger,
} from '@agent-os/sources';
import { SourceAccessTable } from '../sources/source-access-table.js';
import { SOURCES_DECLARATION } from '../sources/sources.config.js';
import { SELF_CHECK_OWNER } from '../auth/system-owners.js';

/**
 * Logger of the program, shared by its runtime, sources and engine. Fields carry identifiers, roles, models, tokens
 * and outcome codes only — never prompts, records or model answers.
 */
export interface SelfCheckLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  log(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ScenarioAssemblyInput {
  /** `DATABASE_URL`, already migrated by the program's start. */
  readonly databaseUrl: string;
  /**
   * What the fixture process serves: `<set>/<scenario>` (`FIXTURE_SCENARIO`), or a pinned dataset version `v1` / `v2`
   * (`FIXTURE_DATASET`) — the slice of an employee's investigation a replay starts on.
   */
  readonly scenario: string;
  /** The run's process configuration as data; `createEngine` checks it. */
  readonly processConfig: unknown;
  /**
   * The judge's catalog model. With the checker agent's model of the run's configuration it is what `Engine.assess` may
   * call: the judge, and the calibration of the checker agent (design-engine.md, «Кто оценивает»).
   */
  readonly judgeModel: string;
  /**
   * `workers` decides whether the dispatcher, the relay and the sweeper run in this process; with `false` the
   * runtime is never started, so no task is claimed or executed (the judge of `show` runs on the engine alone).
   */
  readonly runtime: RuntimeConfig;
  /** Other Sources Settings variables (timeouts, the fixture call log); `FIXTURE_SCENARIO` here is overridden. */
  readonly sourcesVariables?: SourcesEnv;
  readonly clock: Clock;
  readonly resolveModel: ResolveModel;
  readonly tokenCounter: TokenCounter;
  readonly logger: SelfCheckLogger;
}

/** One scenario's runtime, sources and engine over their own pool of the database. */
export interface ScenarioAssembly {
  readonly database: DatabaseConnection;
  readonly runtime: Runtime;
  readonly engine: Engine;
  /**
   * The slice the running fixture serves, read from `fixture://source-info`; the first read starts the fixture
   * process. The adapter's call timeout bounds the read.
   */
  currentFixtureSnapshot(): Promise<string>;
  /** Stops the runtime's workers, then closes the fixture adapter with its process, then the pool. */
  close(): Promise<void>;
}

/**
 * The ownership port of the program's runtime: only `system:self-check` owns a conversation here, so an investigation
 * of any other owner is refused before anything is written (KD-3).
 */
const selfCheckThreads: ThreadOwnership = {
  async withOwnedThread(threadId, resourceId, fn) {
    if (resourceId !== SELF_CHECK_OWNER) {
      throw new Error(
        `Thread ${threadId} of ${resourceId} not found: the self-check program owns only ${SELF_CHECK_OWNER}`,
      );
    }
    return fn();
  },
};

/** The sources every scenario assembly connects: both fixture processes (KD-7). */
const CONNECTED_SOURCES = [FIXTURE_SOURCE_ID, BACKOFFICE_SOURCE_ID];

/**
 * The rights port of the program (design-catalog-planning.md, «Порт прав и заглушка»): the same `SourceAccessTable` as
 * the server's, built in code — its system owner may read every connected source.
 */
const selfCheckAccess = (): SourceAccessTable =>
  new SourceAccessTable(
    JSON.stringify({ [SELF_CHECK_OWNER]: CONNECTED_SOURCES }),
    SOURCES_DECLARATION,
  );

const isDatasetVersion = (value: string): value is DatasetVersion =>
  DATASET_VERSIONS.some((version) => version === value);

/**
 * The Sources Settings variables that pick what the fixture serves: a dataset version clears any scenario the program's
 * variables may name, so the process serves the dataset itself.
 */
function fixtureVariables(served: string): SourcesEnv {
  return isDatasetVersion(served)
    ? { FIXTURE_DATASET: served, FIXTURE_SCENARIO: undefined }
    : { FIXTURE_SCENARIO: served };
}

/** The role the program reads the definition memory's scope `deployment` with: calibration keys its table by those entries. */
const SELF_CHECK_MEMORY_ADMIN_ROLE = 'agent-memory-admin';

/** The checker agent's active `deployment` records, as the turns see them; the form forbids the `user` scope. */
export async function currentDeploymentEntries(
  engine: Pick<Engine, 'listDefinitionMemory'>,
  agent: ClaimAssessmentAgent,
): Promise<{ readonly id: string; readonly text: string }[]> {
  const records = await engine.listDefinitionMemory({
    processId: agent.processId,
    agentName: agent.agentName,
    reader: {
      userId: SELF_CHECK_OWNER,
      roles: [SELF_CHECK_MEMORY_ADMIN_ROLE],
    },
  });
  return records
    .filter((record) => record.scope === 'deployment')
    .map(({ id, text }) => ({ id, text }));
}

/**
 * The models `Engine.assess` and `Engine.assessAgent` may call: the judge and the model of the configuration's
 * definition of the form `claim_assessment`. A configuration the schema refuses adds none — `createEngine` refuses it
 * with `process_config_rejected` anyway.
 */
function assessModels(judgeModel: string, processConfig: unknown): string[] {
  const checkerModel = claimAssessmentAgent(processConfig)?.model;
  return checkerModel === undefined || checkerModel === judgeModel
    ? [judgeModel]
    : [judgeModel, checkerModel];
}

function sourcesLogger(logger: SelfCheckLogger): SourcesLogger {
  return {
    debug: (message, fields) => logger.debug(message, fields),
    warn: (message, fields) => logger.warn(message, fields),
    error: (message, fields) => logger.error(message, fields),
  };
}

/**
 * Assembly for one scenario (design-self-check.md, C3 self-check, «сборка на сценарий»): the same assembly functions
 * as the server — `createRuntime`, `createSources` with the fixture adapter on `FIXTURE_SCENARIO`, `createEngine` with
 * the run's configuration and `assessModels` = [judge model, the checker agent's model of that configuration] — over the
 * database of `DATABASE_URL`, its investigations owned by `system:self-check`. The engine is built without the mandatory-calibration flag. Handlers are registered
 * before the workers start; with the workers off `runtime.start` is not called at all, and `Engine.assess` — model
 * gateway, ledger, transcripts — works without it.
 *
 * A refused configuration or judge model throws `process_config_rejected` from `createEngine`; what was opened by
 * then is closed before the error propagates. No fixture process is started by the assembly itself: the adapter
 * starts it on the first call.
 */
export async function assembleScenario(
  input: ScenarioAssemblyInput,
): Promise<ScenarioAssembly> {
  const { clock, logger } = input;
  const database = createDatabase({
    connectionString: input.databaseUrl,
    poolMax: input.runtime.dbPoolMax,
  });
  let sources: Sources | null = null;
  try {
    const runtime = createRuntime({
      database,
      config: input.runtime,
      threads: selfCheckThreads,
      logger,
      clock,
    });
    const settings = parseSourcesSettings({
      ...input.sourcesVariables,
      ...fixtureVariables(input.scenario),
    });
    const sourcesLog = sourcesLogger(logger);
    // Both fixture processes serve the same scenario or dataset (KD-7).
    const adapterOptions = {
      serverPath: fixtureServerPath,
      settings,
      logger: sourcesLog,
    };
    sources = createSources({
      handlers: runtime.handlers,
      adapters: [
        new FixtureSourceAdapter(adapterOptions),
        new BackofficeSourceAdapter(adapterOptions),
      ],
      declaration: SOURCES_DECLARATION,
      settings,
      clock,
      logger: sourcesLog,
    });
    const { handlers, eventConsumers, scheduler, investigations } = runtime;
    const engine = createEngine({
      database: database.db,
      runtime: {
        handlers,
        eventConsumers,
        scheduler,
        investigations,
      },
      sourceRegistry: sources.registry,
      connectedSources: CONNECTED_SOURCES,
      toolAccessPolicy: selfCheckAccess(),
      processes: [input.processConfig],
      assessModels: assessModels(input.judgeModel, input.processConfig),
      memoryAdminRole: SELF_CHECK_MEMORY_ADMIN_ROLE,
      resolveModel: input.resolveModel,
      tokenCounter: input.tokenCounter,
      clock,
      logger,
    });
    if (input.runtime.workers) runtime.start();
    const opened = sources;
    return {
      database,
      runtime,
      engine,
      currentFixtureSnapshot: () =>
        opened.registry.currentSnapshot(
          FIXTURE_SOURCE_ID,
          new AbortController().signal,
        ),
      async close() {
        await runtime.stop();
        try {
          await opened.close();
        } finally {
          await database.close();
        }
      },
    };
  } catch (error) {
    try {
      await sources?.close();
    } finally {
      await database.close();
    }
    throw error;
  }
}
