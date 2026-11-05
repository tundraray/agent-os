import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@agent-os/db';
import {
  type Clock,
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  type RuntimeLogFields,
  type RuntimeLogger,
  systemClock,
  type TaskHandler,
  type ThreadOwnership,
} from '@agent-os/runtime';
import { databaseUrl } from './database-url.js';

/**
 * Test assembly of the runtime (design-runtime.md, Test Boundaries): the package's own
 * `createRuntime` over its own pool, without `apps/api`. The package is imported by name, so the
 * in-process tests and the compiled kill-matrix child run the same built `dist`.
 */

export interface RuntimeHarnessOptions {
  /** Test handlers, registered before the workers start. */
  handlers: readonly TaskHandler[];
  /** Runtime Settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4). */
  runtime?: Partial<RuntimeConfig>;
  /** The runtime's clock; the system clock by default. */
  clock?: Clock;
  /** Also print every log line (the child process, whose output the harness keeps on failure). */
  echoLogs?: boolean;
}

/** One recorded call of the test {@link RuntimeLogger}. */
export type LogCall = [message: string, fields: RuntimeLogFields | undefined];

/** Calls of the test logger by level, in order; a test may empty them. */
export interface RuntimeLogs {
  log: LogCall[];
  warn: LogCall[];
  error: LogCall[];
}

export interface RuntimeHarness extends Runtime {
  /** The Drizzle client of the runtime's pool. */
  db: Database;
  /** The settings the runtime was built with. */
  config: RuntimeConfig;
  clock: Clock;
  /** The logger handed to the runtime; its calls are in {@link logs}. */
  logger: RuntimeLogger;
  logs: RuntimeLogs;
  /** A new thread of `resourceId` known to the ownership double; returns its id. */
  createThread(resourceId: string): Promise<string>;
  /** Closes the pool; call after {@link Runtime.stop}. */
  closeDatabase(): Promise<void>;
  /** Stops the runtime, then closes the pool — the pool is closed even when the stop fails. */
  close(): Promise<void>;
}

/** Ownership double of the threads the harness created: a missing or foreign thread is refused. */
function threadOwnershipDouble(owners: ReadonlyMap<string, string>) {
  const threads: ThreadOwnership = {
    async withOwnedThread(threadId, resourceId, fn) {
      if (owners.get(threadId) !== resourceId) {
        throw new Error(`Thread ${threadId} of ${resourceId} not found`);
      }
      return fn();
    },
  };
  return threads;
}

function recordingLogger(echo: boolean): {
  logger: RuntimeLogger;
  logs: RuntimeLogs;
} {
  const logs: RuntimeLogs = { log: [], warn: [], error: [] };
  const record =
    (level: keyof RuntimeLogs) =>
    (message: string, fields?: RuntimeLogFields): void => {
      logs[level].push([message, fields]);
      if (echo) console.log(`[runtime ${level}] ${message}`, fields ?? '');
    };
  return {
    logger: {
      log: record('log'),
      warn: record('warn'),
      error: record('error'),
    },
    logs,
  };
}

/** Builds the runtime with the test handlers against the test database and starts it. */
export async function createRuntimeHarness(
  options: RuntimeHarnessOptions,
): Promise<RuntimeHarness> {
  const config: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 2,
    pollMs: 50,
    dbPoolMax: 4,
    ...options.runtime,
  };
  const clock = options.clock ?? systemClock;
  const { logger, logs } = recordingLogger(options.echoLogs ?? false);
  const owners = new Map<string, string>();
  const database = createDatabase({
    connectionString: databaseUrl(),
    poolMax: config.dbPoolMax,
  });
  const runtime = createRuntime({
    database,
    config,
    threads: threadOwnershipDouble(owners),
    logger,
    clock,
  });
  for (const handler of options.handlers) runtime.handlers.register(handler);
  runtime.start();

  return {
    ...runtime,
    db: database.db,
    config,
    clock,
    logger,
    logs,
    createThread: async (resourceId) => {
      const threadId = `thread-${randomUUID()}`;
      owners.set(threadId, resourceId);
      return threadId;
    },
    closeDatabase: () => database.close(),
    close: async () => {
      try {
        await runtime.stop();
      } finally {
        await database.close();
      }
    },
  };
}
