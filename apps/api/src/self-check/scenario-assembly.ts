import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import {
  createEngine,
  type Engine,
  loadProcessConfig,
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
  createSources,
  FIXTURE_SOURCE_ID,
  FixtureSourceAdapter,
  parseSourcesSettings,
  type Sources,
  type SourcesEnv,
  type SourcesLogger,
} from '@agent-os/sources';
import { SOURCES_ALLOWLIST } from '../sources/sources.config.js';
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
   * The judge's catalog model. With the `verifier` model of the run's configuration it is what `Engine.assess` may
   * call: the judge, and the calibration of the `verifier` call (design-engine.md, «Кто оценивает»).
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

/**
 * The models `Engine.assess` may call: the judge and the `verifier` model of the configuration. A configuration the
 * schema refuses adds none — `createEngine` refuses it with `process_config_rejected` anyway.
 */
function assessModels(judgeModel: string, processConfig: unknown): string[] {
  const loaded = loadProcessConfig(processConfig);
  if (!loaded.ok) return [judgeModel];
  const verifierModel = loaded.config.roles.verifier.model;
  return verifierModel === judgeModel
    ? [judgeModel]
    : [judgeModel, verifierModel];
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
 * the run's configuration and `assessModels` = [judge model, `verifier` model of that configuration] — over the
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
    sources = createSources({
      handlers: runtime.handlers,
      adapters: [
        new FixtureSourceAdapter({
          serverPath: fixtureServerPath,
          settings,
          logger: sourcesLog,
        }),
      ],
      allowlist: SOURCES_ALLOWLIST,
      settings,
      clock,
      logger: sourcesLog,
    });
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
      processes: [input.processConfig],
      assessModels: assessModels(input.judgeModel, input.processConfig),
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
