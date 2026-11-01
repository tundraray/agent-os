import { randomUUID } from 'node:crypto';
import type { Investigation } from '@agent-os/contracts';
import { createDatabase, type Database } from '@agent-os/db';
import {
  createEngine,
  deepResearchProcessV1,
  type Engine,
  type EngineLogger,
  type ResolveModel,
  type RoleModel,
  type TokenCounter,
  type TokenCountRequest,
  type TokenCountResult,
} from '@agent-os/engine';
import {
  type Clock,
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  type RuntimeLogger,
  systemClock,
  type ThreadOwnership,
} from '@agent-os/runtime';
import { createSources, parseSourcesSettings, type Sources, type SourcesLogger } from '@agent-os/sources';
import { COUNTING_SOURCE_ID, type CountingSource, createCountingSource } from './countingSource.js';
import { databaseUrl } from './database-url.js';

/**
 * Test assembly of the engine (design-engine.md, Test Strategy): the real `createRuntime`, `createSources` and
 * `createEngine` over the test database, without `apps/api`. Doubles stand only at the boundaries: the model port
 * `resolveModel`, the `TokenCounter`, the in-memory counting source, the thread-ownership port, the clock and the
 * loggers. The engine package is imported by name, as the runtime and sources harnesses import theirs.
 */

/** Budget of the shipped deep-research configuration: what a start asks `InvestigationService.create` for. */
const DEFAULT_BUDGET = { maxTasks: 300, maxToolCalls: 3_000 };

/** What may change when the engine is (re)built over the same database. */
export interface EngineBuildOptions {
  /** Process configurations as data; the shipped deep-research configuration by default. */
  processes?: readonly unknown[];
  /** The counting source's id by default (mode `sources`); `[]` for the no-source mode. */
  connectedSources?: readonly string[];
}

export interface EngineHarnessOptions extends EngineBuildOptions {
  /** Runtime Settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4); `workers: false` builds without workers. */
  runtime?: Partial<RuntimeConfig>;
  /** The clock of the runtime and the sources; the system clock by default. */
  clock?: Clock;
}

/** One recorded log call. */
export type LogLine = [message: string, fields: unknown];

/** Calls of a test logger by level, in order; a test may empty them. */
export interface LogLines {
  log: LogLine[];
  warn: LogLine[];
  error: LogLine[];
}

/**
 * Deterministic `TokenCounter`: one token per character of the instructions and the messages, plus `offset` — set it
 * to make the counted input differ from what the model double reports (DC-13).
 */
export interface OffsetTokenCounter extends TokenCounter {
  offset: number;
  /** Every request counted, in order. */
  readonly requests: TokenCountRequest[];
}

export interface EngineHarness {
  /** The Drizzle client of the harness pool. */
  readonly db: Database;
  /** Replaced by {@link rebuildEngine}. */
  readonly runtime: Runtime;
  /** Replaced by {@link rebuildEngine}. */
  readonly engine: Engine;
  readonly countingSource: CountingSource;
  readonly tokenCounter: OffsetTokenCounter;
  readonly resolveModel: ResolveModel;
  readonly clock: Clock;
  readonly logs: { readonly runtime: LogLines; readonly engine: LogLines; readonly sources: LogLines };
  /** A new thread of `resourceId` known to the ownership double; returns its id. */
  createThread(resourceId: string): Promise<string>;
  /**
   * The state a start killed between `InvestigationService.create` and the engine row leaves (KD-9): an investigation
   * created by the real service, with no engine row and no task. The deep-research budget by default.
   */
  seedShell(shell: {
    resourceId: string;
    threadId: string;
    query: string;
    budget?: Investigation['budget'];
  }): Promise<Investigation>;
  /**
   * Stops the runtime and builds a new runtime, sources and engine over the same database and threads — a restart of
   * the process with other configurations or `connectedSources` (UC-10, UC-11). Returns the new engine.
   */
  rebuildEngine(options?: EngineBuildOptions): Promise<Engine>;
  /** Stops the runtime and closes the sources, then the pool — the pool even when the stop fails. */
  close(): Promise<void>;
}

function recordingLogs(): LogLines {
  return { log: [], warn: [], error: [] };
}

/** A logger of the engine or the runtime writing into `lines`. */
function recordingLogger(lines: LogLines): EngineLogger & RuntimeLogger {
  const record =
    (level: keyof LogLines) =>
    (message: string, fields?: unknown): void => {
      lines[level].push([message, fields]);
    };
  return { log: record('log'), warn: record('warn'), error: record('error') };
}

function sourcesLogger(lines: LogLines): SourcesLogger {
  return {
    debug: () => undefined,
    warn: (message, fields) => lines.warn.push([message, fields]),
    error: (message, fields) => lines.error.push([message, fields]),
  };
}

/** Ownership double of the threads the harness created: a missing or foreign thread is refused. */
function threadOwnershipDouble(owners: ReadonlyMap<string, string>): ThreadOwnership {
  return {
    async withOwnedThread(threadId, resourceId, fn) {
      if (owners.get(threadId) !== resourceId) {
        throw new Error(`Thread ${threadId} of ${resourceId} not found`);
      }
      return fn();
    },
  };
}

function offsetTokenCounter(): OffsetTokenCounter {
  const counter: OffsetTokenCounter = {
    offset: 0,
    requests: [],
    countInputTokens(request): Promise<TokenCountResult> {
      counter.requests.push(request);
      const characters =
        request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0);
      return Promise.resolve({ outcome: 'counted', inputTokens: characters + counter.offset });
    },
  };
  return counter;
}

/**
 * The model port until the scripted model double arrives (task-09): an instance per model id that the engine only
 * hands to role agents. Creation resolves every role model; nothing calls the instance yet, so a call fails loudly.
 */
const unscriptedModel: ResolveModel = (modelId): RoleModel => {
  const unscripted = () => Promise.reject(new Error(`model ${modelId} has no script in this harness`));
  return {
    specificationVersion: 'v2',
    provider: 'engine-harness',
    modelId,
    supportedUrls: {},
    doGenerate: unscripted,
    doStream: unscripted,
  };
};

/** Builds the database, runtime, sources and engine, and starts the runtime's workers unless they are off. */
export async function createEngineHarness(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const config: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 2,
    pollMs: 50,
    dbPoolMax: 4,
    ...options.runtime,
  };
  const clock = options.clock ?? systemClock;
  const logs = { runtime: recordingLogs(), engine: recordingLogs(), sources: recordingLogs() };
  const owners = new Map<string, string>();
  const database = createDatabase({ connectionString: databaseUrl(), poolMax: config.dbPoolMax });
  const countingSource = createCountingSource();
  const tokenCounter = offsetTokenCounter();
  const sourcesSettings = parseSourcesSettings({ SOURCE_RETRY_BASE_MS: '10', SOURCE_RETRY_CAP_MS: '50' });
  let build: EngineBuildOptions = {
    processes: options.processes ?? [deepResearchProcessV1],
    connectedSources: options.connectedSources ?? [COUNTING_SOURCE_ID],
  };

  /** createEngine runs before the workers start, as in the composition root (handlers registered before a claim). */
  function assemble(): { runtime: Runtime; sources: Sources; engine: Engine } {
    const runtime = createRuntime({
      database,
      config,
      threads: threadOwnershipDouble(owners),
      logger: recordingLogger(logs.runtime),
      clock,
    });
    const sources = createSources({
      handlers: runtime.handlers,
      adapters: [countingSource.adapter],
      allowlist: countingSource.allowlist,
      settings: sourcesSettings,
      clock,
      logger: sourcesLogger(logs.sources),
    });
    const engine = createEngine({
      database: database.db,
      runtime: { scheduler: runtime.scheduler, investigations: runtime.investigations },
      sourceRegistry: sources.registry,
      connectedSources: build.connectedSources ?? [],
      processes: build.processes ?? [],
      resolveModel: unscriptedModel,
      logger: recordingLogger(logs.engine),
    });
    runtime.start();
    return { runtime, sources, engine };
  }

  let current = assemble();
  const stop = async (): Promise<void> => {
    try {
      await current.runtime.stop();
    } finally {
      await current.sources.close();
    }
  };

  return {
    db: database.db,
    get runtime() {
      return current.runtime;
    },
    get engine() {
      return current.engine;
    },
    countingSource,
    tokenCounter,
    resolveModel: unscriptedModel,
    clock,
    logs,
    createThread: async (resourceId) => {
      const threadId = `thread-${randomUUID()}`;
      owners.set(threadId, resourceId);
      return threadId;
    },
    seedShell: ({ resourceId, threadId, query, budget = DEFAULT_BUDGET }) =>
      current.runtime.investigations.create({ resourceId, threadId, query, budget }),
    rebuildEngine: async (next = {}) => {
      await stop();
      build = { ...build, ...next };
      current = assemble();
      return current.engine;
    },
    close: async () => {
      try {
        await stop();
      } finally {
        await database.close();
      }
    },
  };
}
