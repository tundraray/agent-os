import {
  createDatabase,
  type Database,
  type DatabaseConnection,
} from '@agent-os/db';
import type { ResolveModel, TokenCounter } from '@agent-os/engine';
import type { Clock, RuntimeConfig } from '@agent-os/runtime';
import type { SourcesEnv } from '@agent-os/sources';
import { parseTranscriptRetention } from '../engine/transcript-retention.js';
import {
  assembleScenario,
  type ScenarioAssembly,
  type SelfCheckLogger,
} from './scenario-assembly.js';
import { loadSelfCheckSettings, type SelfCheckSettings } from './settings.js';
import { cancelLeftoverInvestigations, startUp } from './startup.js';

/**
 * The ports every command of the program runs on. `main.ts` fills them from the environment; tests pass them
 * explicitly — the runtime settings above all, since the e2e config turns the workers off by default.
 */
export interface SelfCheckPorts {
  /**
   * `DATABASE_URL`: the database the program shares with the server (design-self-check.md, KD-3). It is run on a
   * developer's database where the server's runtime workers are off and no employee investigation is unfinished; the
   * program does not check that.
   */
  readonly databaseUrl: string;
  /** Where run directories are written. */
  readonly reportsDir: string;
  readonly clock: Clock;
  readonly resolveModel: ResolveModel;
  readonly tokenCounter: TokenCounter;
  readonly logger: SelfCheckLogger;
  /**
   * The retention term of the employees' transcripts, parsed from `TRANSCRIPT_RETENTION_DAYS`; absent is the variable
   * unset (30 days).
   */
  readonly transcriptRetention?: { readonly days: number };
  /** Runtime Settings; `workers` decides whether this process executes the investigations' tasks. */
  readonly runtime: RuntimeConfig;
  /** Other Sources Settings variables, e.g. the fixture call log; the program sets `FIXTURE_SCENARIO` itself. */
  readonly sourcesVariables?: SourcesEnv;
}

/** What a scenario assembly takes from the command: everything else comes from the program. */
export interface ScenarioRequest {
  /** `<set>/<scenario>`. */
  readonly scenario: string;
  /** The run's process configuration as data. */
  readonly processConfig: unknown;
  /**
   * Whether this process executes the investigations' tasks (dispatcher, outbox relay, recovery sweeper); by default
   * the program's runtime settings decide. `show` passes `false`: it only reads an investigation and calls
   * `Engine.assess`, so a task left queued by a dropped `run` is never claimed by it.
   */
  readonly workers?: boolean;
}

export interface SelfCheckProgram {
  readonly settings: SelfCheckSettings;
  readonly reportsDir: string;
  readonly clock: Clock;
  readonly logger: SelfCheckLogger;
  /** Runtime, sources and engine for one scenario over the database; the caller closes it. */
  assembleScenario(request: ScenarioRequest): Promise<ScenarioAssembly>;
  /**
   * Cancels every unfinished investigation of `system:self-check` and waits until none of their tasks can run
   * (DC-18); an employee's investigation is not touched. `run` and `replay` call it after their refusals that need no
   * assembly and before their first assembly; `show` never does.
   */
  cancelLeftovers(): Promise<void>;
  /**
   * The database, opened on first use, for reads that need no scenario assembly: `replay` and `show` read an original
   * by its owner before any fixture is started.
   */
  database(): Database;
  /**
   * The retention term of the employees' transcripts: `show` of an employee's investigation reads within it, and a
   * copy of an employee's original older than it is removed at the start.
   */
  transcriptRetention(): { readonly days: number };
  /** Closes the database connection it opened; scenario assemblies are closed by their callers. */
  close(): Promise<void>;
}

/**
 * The common assembly of the program from its ports (design-self-check.md, KD-3): the settings file is checked by
 * its schema, then the start runs — migrations, expired copies — and only then is anything assembled.
 */
export async function createSelfCheckProgram(
  ports: SelfCheckPorts,
): Promise<SelfCheckProgram> {
  const settings = loadSelfCheckSettings();
  const transcriptRetention =
    ports.transcriptRetention ?? parseTranscriptRetention(() => undefined);
  const startupInput = { ...ports, transcriptRetention };
  await startUp(startupInput);
  const { clock, logger, databaseUrl } = ports;
  let database: DatabaseConnection | null = null;

  return {
    settings,
    reportsDir: ports.reportsDir,
    clock,
    logger,
    assembleScenario: (request) =>
      assembleScenario({
        databaseUrl,
        scenario: request.scenario,
        processConfig: request.processConfig,
        judgeModel: settings.judge.model,
        runtime:
          request.workers === false
            ? { ...ports.runtime, workers: false }
            : ports.runtime,
        sourcesVariables: ports.sourcesVariables,
        clock,
        resolveModel: ports.resolveModel,
        tokenCounter: ports.tokenCounter,
        logger,
      }),
    cancelLeftovers: () => cancelLeftoverInvestigations(startupInput),
    database() {
      database ??= createDatabase({
        connectionString: databaseUrl,
        poolMax: ports.runtime.dbPoolMax,
      });
      return database.db;
    },
    transcriptRetention: () => transcriptRetention,
    async close() {
      const opened = database;
      database = null;
      await opened?.close();
    },
  };
}
