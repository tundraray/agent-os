import { createLogger, type LogRecord } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import { createDatabase, type Database } from '@agent-os/db';
import {
  type Clock,
  createRuntime,
  type ModelPrices,
  parseModelPrices,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
  type TaskHandler,
} from '@agent-os/runtime';
import { sql } from 'drizzle-orm';
import { databaseUrl } from './database-url.js';
import { ensureHandlerRowsTable } from './testHandlers.js';

/**
 * Test assembly of the runtime (design-runtime.md, Test Strategy): the package's own
 * `createRuntime` over its own pool, without `apps/api`. The package is imported by name, so the
 * in-process tests and the compiled child of E2E-1 run the same built `dist`. A second instance is
 * a second harness over the same database.
 */

/** A priced model of {@link TEST_MODEL_PRICES}: input 1, output 5 USD per million tokens. */
export const TEST_MODEL_ONE = 'test/model-one';
/** A priced model of {@link TEST_MODEL_PRICES}: input 3, output 15 USD per million tokens. */
export const TEST_MODEL_TWO = 'test/model-two';

/**
 * The prices of every harness: two models with different input and output prices, all rates exact
 * in binary so that hand-computed costs are literal. Expected costs are computed from these
 * numbers by hand, never by the cost rule.
 */
export const TEST_MODEL_PRICES: ModelPrices = parseModelPrices({
  [TEST_MODEL_ONE]: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.125,
  },
  [TEST_MODEL_TWO]: {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheWriteUsdPerMTok: 3.75,
    cacheReadUsdPerMTok: 0.375,
  },
});

/** A clock whose `now` the test sets; timers and randomness are the system's. */
export interface SettableClock extends Clock {
  set(now: Date): void;
}

export function settableClock(start: Date): SettableClock {
  let current = start;
  return {
    now: () => current,
    random: () => systemClock.random(),
    setTimer: (...args) => systemClock.setTimer(...args),
    set: (now) => {
      current = now;
    },
  };
}

export interface RuntimeHarnessOptions {
  /** Test handlers, registered before the workers start. */
  handlers: readonly TaskHandler[];
  /** Runtime settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4). */
  config?: Partial<RuntimeConfig>;
  /** The runtime's clock; the system clock by default. */
  clock?: Clock;
  /** `false` holds the workers until {@link RuntimeHarness.start}; on by default. */
  startWorkers?: boolean;
}

export interface RuntimeHarness extends Runtime {
  /** The Drizzle client of the runtime's pool. */
  readonly db: Database;
  /** Every record the runtime logged, in order: the in-memory sink of `@agent-os/common/testing`. */
  readonly logs: readonly LogRecord[];
  /** Stops the workers, then closes the pool — the pool is closed even when the stop fails. */
  close(): Promise<void>;
}

/**
 * Moves the lease of the task's running step into the past, as if its process had stopped
 * beating: the next pass of a recovery sweeper requeues the step. Throws when the task is not
 * `running`, so a test never races a lease that was not there.
 */
export async function expireLease(db: Database, taskId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE app.runtime_tasks SET lease_expires_at = now() - interval '1 minute'
     WHERE task_id = ${taskId} AND status = 'running'
    RETURNING task_id`);
  if (rows.length !== 1) throw new Error(`Task ${taskId} has no running step to expire`);
}

/** Builds the runtime with the test handlers against the test database. */
export async function createRuntimeHarness(
  options: RuntimeHarnessOptions,
): Promise<RuntimeHarness> {
  const config: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 2,
    pollMs: 50,
    dbPoolMax: 4,
    ...options.config,
  };
  const sink = memorySink();
  const logger = createLogger({ sinks: [sink], secrets: [], minLevel: 'debug' });
  const database = createDatabase({
    connectionString: databaseUrl(),
    poolMax: config.dbPoolMax,
  });
  await ensureHandlerRowsTable(database.db);
  const runtime = createRuntime({
    database,
    config,
    logger,
    clock: options.clock ?? systemClock,
    modelPrices: TEST_MODEL_PRICES,
  });
  for (const handler of options.handlers) runtime.handlers.register(handler);
  if (options.startWorkers ?? true) runtime.start();

  return {
    ...runtime,
    db: database.db,
    logs: sink.records,
    close: async () => {
      try {
        await runtime.stop();
      } finally {
        await database.close();
      }
    },
  };
}
