import { consoleSink, createLogger } from '@agent-os/common';
import { createDatabase } from '@agent-os/db';
import { createRuntime, parseRuntimeConfig, systemClock } from '@agent-os/runtime';
import { type ChildTypes, CHILD_TYPES_ENV, handlersFor } from './runtimeChildHandlers.js';
import { TEST_MODEL_PRICES } from './runtimeHarness.js';
import { ensureHandlerRowsTable } from './testHandlers.js';

/**
 * Entry of the E2E-1 child process, run only compiled (`pnpm --filter @agent-os/runtime
 * build:child` → `dist/test-child/`). It is the composition root of its runtime: it reads its
 * environment — `DATABASE_URL`, the Runtime settings (`RUNTIME_WORKERS=on`, short lease, reaper and
 * poll, `RUNTIME_MAX_RECOVERIES`, `RUNTIME_CRASH_AT` for a dying start) and the task types it
 * registers — then builds `createDatabase` + `createRuntime` from the packages' built `dist` and
 * starts the workers. It creates no tasks: the test process does. IPC: the child sends
 * `{ kind: 'ready' }` once its workers run; `{ kind: 'stop' }` stops them, closes the pool and
 * exits 0. A crash point exits 137 on its own.
 */

/** Messages of the child to the harness. */
export type ChildMessage = { kind: 'ready' };
/** Messages of the harness to the child. */
export type HarnessMessage = { kind: 'stop' };

function readTypes(): ChildTypes {
  const raw = process.env[CHILD_TYPES_ENV];
  if (!raw) throw new Error(`${CHILD_TYPES_ENV} is not set`);
  return JSON.parse(raw) as ChildTypes;
}

function send(message: ChildMessage): void {
  if (!process.send) throw new Error('The child process has no IPC channel');
  process.send(message);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const config = parseRuntimeConfig(process.env);
  const logger = createLogger({ sinks: [consoleSink()], secrets: [], minLevel: 'info' });
  const database = createDatabase({ connectionString, poolMax: config.dbPoolMax });
  await ensureHandlerRowsTable(database.db);
  const runtime = createRuntime({
    database,
    config,
    logger,
    clock: systemClock,
    modelPrices: TEST_MODEL_PRICES,
  });
  for (const handler of handlersFor(readTypes(), database.db)) {
    runtime.handlers.register(handler);
  }

  process.on('message', (message: HarnessMessage) => {
    if (message.kind !== 'stop') return;
    runtime
      .stop()
      .finally(() => database.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('child runtime stop failed', { error });
          process.exit(1);
        },
      );
  });

  runtime.start();
  send({ kind: 'ready' });
}

main().catch((error: unknown) => {
  createLogger({ sinks: [consoleSink()], secrets: [], minLevel: 'error' }).error(
    'runtime child failed',
    { error },
  );
  process.exit(1);
});
