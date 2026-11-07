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
import {
  cancelLeftoverInvestigations,
  openMainDatabase,
  startUp,
} from './startup.js';

/**
 * The ports every command of the program runs on. `main.ts` fills them from the environment; tests pass them
 * explicitly — the runtime settings above all, since the e2e config turns the workers off by default.
 */
export interface SelfCheckPorts {
  /** `SELF_CHECK_DATABASE_URL`. */
  readonly selfCheckDatabaseUrl: string | undefined;
  /** `DATABASE_URL`: compared by the guard, and read — only read — by the commands that reach the main database. */
  readonly mainDatabaseUrl: string | undefined;
  /** Where run directories are written. */
  readonly reportsDir: string;
  readonly clock: Clock;
  readonly resolveModel: ResolveModel;
  readonly tokenCounter: TokenCounter;
  readonly logger: SelfCheckLogger;
  /**
   * The retention term of the main database, parsed from `TRANSCRIPT_RETENTION_DAYS`; absent is the variable unset
   * (30 days).
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
  /** Runtime, sources and engine for one scenario over the self-check database; the caller closes it. */
  assembleScenario(request: ScenarioRequest): Promise<ScenarioAssembly>;
  /**
   * Cancels every unfinished investigation of the self-check database and waits until none of their tasks can run
   * (DC-18). `run` and `replay` call it after their refusals that need no assembly and before their first assembly;
   * `show` never does.
   */
  cancelLeftovers(): Promise<void>;
  /**
   * The main database, opened on first use with every transaction read-only on the server side
   * (`default_transaction_read_only`): the program never writes there (invariant 5). Throws when `DATABASE_URL` is
   * not set.
   */
  mainDatabase(): Database;
  /**
   * The self-check database, opened on first use, for reads that need no scenario assembly (`replay` reads an
   * original of the base `self_check` before any fixture is started).
   */
  selfCheckDatabase(): Database;
  /**
   * The retention term of the main database: `show` over the main database reads within it, and a copy of a main
   * original older than it is removed at the start.
   */
  mainTranscriptRetention(): { readonly days: number };
  /** Closes the database connections it opened; scenario assemblies are closed by their callers. */
  close(): Promise<void>;
}

export type CreateSelfCheckProgramResult =
  | { readonly ok: true; readonly program: SelfCheckProgram }
  | {
      readonly ok: false;
      readonly code: 'database_not_self_check';
      readonly reason: string;
    };

/**
 * The common assembly of the program from its ports (design-self-check.md, KD-3): the settings file is checked by
 * its schema, then the start runs — guard, migrations, expired copies — and only then is anything assembled. A refused
 * database is returned as a result, before any connection that writes.
 */
export async function createSelfCheckProgram(
  ports: SelfCheckPorts,
): Promise<CreateSelfCheckProgramResult> {
  const settings = loadSelfCheckSettings();
  const transcriptRetention =
    ports.transcriptRetention ?? parseTranscriptRetention(() => undefined);
  const startupInput = { ...ports, transcriptRetention };
  const started = await startUp(startupInput);
  if (!started.ok) return started;
  const { databaseUrl } = started;
  const { clock, logger } = ports;
  let main: DatabaseConnection | null = null;
  let selfCheck: DatabaseConnection | null = null;

  const program: SelfCheckProgram = {
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
    cancelLeftovers: () =>
      cancelLeftoverInvestigations(databaseUrl, startupInput),
    mainDatabase() {
      main ??= openMainDatabase(ports.mainDatabaseUrl, ports.runtime.dbPoolMax);
      return main.db;
    },
    selfCheckDatabase() {
      selfCheck ??= createDatabase({
        connectionString: databaseUrl,
        poolMax: ports.runtime.dbPoolMax,
      });
      return selfCheck.db;
    },
    mainTranscriptRetention: () => transcriptRetention,
    async close() {
      const opened = [main, selfCheck].filter(
        (connection): connection is DatabaseConnection => connection !== null,
      );
      main = null;
      selfCheck = null;
      await Promise.all(opened.map((connection) => connection.close()));
    },
  };
  return { ok: true, program };
}
