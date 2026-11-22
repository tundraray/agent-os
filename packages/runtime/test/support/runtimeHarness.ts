import { createLogger, type LogRecord } from '@agent-os/common';
import { memorySink } from '@agent-os/common/testing';
import { DATABASE, type Database, DbModule } from '@agent-os/db';
import {
  CLOCK,
  type Clock,
  Decisions,
  EventConsumerRegistry,
  EventLog,
  HandlerRegistry,
  Inbox,
  type ModelPrice,
  parseRuntimeConfig,
  type RuntimeConfig,
  RuntimeModule,
  RuntimeWorkers,
  systemClock,
  type TaskHandler,
  TaskControl,
  TokenLedger,
  Trackers,
} from '@agent-os/runtime';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { databaseUrl } from './database-url';
import { loggerModule } from './loggerModule';
import { ensureHandlerRowsTable } from './testHandlers';

/**
 * Test assembly of the runtime (design-runtime.md, Test Strategy): a Nest context of the package's
 * own `RuntimeModule` over `DbModule` with its own pool, without `apps/api`. The package is imported
 * by name, as the child of E2E-1 imports it. A second instance is a second harness over the same
 * database.
 */

/*
 * Two test models with different input and output prices, all rates exact in binary so that
 * hand-computed costs are literal. A call to the ledger carries its model's price (ADR-0015).
 * Expected costs are computed from these numbers by hand, never by the cost rule.
 */

/** A test model priced at {@link TEST_MODEL_ONE_PRICE}. */
export const TEST_MODEL_ONE = 'test/model-one';
/** Input 1, output 5 USD per million tokens. */
export const TEST_MODEL_ONE_PRICE: ModelPrice = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.125,
};

/** A test model priced at {@link TEST_MODEL_TWO_PRICE}. */
export const TEST_MODEL_TWO = 'test/model-two';
/** Input 3, output 15 USD per million tokens. */
export const TEST_MODEL_TWO_PRICE: ModelPrice = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  cacheWriteUsdPerMTok: 3.75,
  cacheReadUsdPerMTok: 0.375,
};

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

export interface RuntimeHarness {
  readonly handlers: HandlerRegistry;
  readonly tasks: TaskControl;
  readonly inbox: Inbox;
  readonly decisions: Decisions;
  readonly trackers: Trackers;
  readonly events: EventLog;
  readonly eventConsumers: EventConsumerRegistry;
  readonly ledger: TokenLedger;
  /** Starts the workers (`RuntimeWorkers.start`). */
  start(): void;
  /** Stops the workers (`RuntimeWorkers.stop`). */
  stop(): Promise<void>;
  /** The Drizzle client of the runtime's pool. */
  readonly db: Database;
  /** Every record the runtime logged, in order: the in-memory sink of `@agent-os/common/testing`. */
  readonly logs: readonly LogRecord[];
  /** Closes the context: the workers stop, then `DbModule` closes the pool. */
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
  const app = await Test.createTestingModule({
    imports: [
      loggerModule(logger),
      DbModule.forRootAsync({
        useFactory: () => ({ connectionString: databaseUrl(), poolMax: config.dbPoolMax }),
      }),
      RuntimeModule.forRootAsync({ useFactory: () => config }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? systemClock)
    .compile();
  const db = app.get<Database>(DATABASE);
  await ensureHandlerRowsTable(db);
  const handlers = app.get(HandlerRegistry);
  for (const handler of options.handlers) handlers.register(handler);
  const workers = app.get(RuntimeWorkers);
  // The context's start runs `onApplicationBootstrap`, which starts the workers; held workers
  // start by `start()`. `close()` runs the shutdown hooks either way.
  if (options.startWorkers ?? true) await app.init();

  return {
    handlers,
    tasks: app.get(TaskControl),
    inbox: app.get(Inbox),
    decisions: app.get(Decisions),
    trackers: app.get(Trackers),
    events: app.get(EventLog),
    eventConsumers: app.get(EventConsumerRegistry),
    ledger: app.get(TokenLedger),
    start: () => workers.start(),
    stop: () => workers.stop(),
    db,
    logs: sink.records,
    close: () => app.close(),
  };
}
