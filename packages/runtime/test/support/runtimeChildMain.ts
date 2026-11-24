import { consoleSink, createLogger } from '@agent-os/common';
import { Db } from '@agent-os/db';
import { HandlerRegistry, parseRuntimeConfig } from '@agent-os/runtime';
import { runtimeModules, serveHarness } from '@agent-os/runtime/testing';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  type ChildTypes,
  CHILD_TYPES_ENV,
  handlersFor,
} from './runtimeChildHandlers';
import { ensureHandlerRowsTable } from './testHandlers';

/**
 * Entry of the E2E-1 child process, run from source through `tsx`. It is the composition root of its runtime: it reads its
 * environment — `DATABASE_URL`, the Runtime settings (`RUNTIME_WORKERS=on`, short reaper and
 * poll, `RUNTIME_MAX_RECOVERIES`, `RUNTIME_CRASH_AT` for a dying start) and the task types it
 * registers — then builds a Nest context of `DbModule` + `RuntimeModule` from the packages, whose
 * start registers the handlers and starts the workers. It creates no tasks: the test process does.
 * IPC: the child sends `{ kind: 'ready' }` once its workers run; `{ kind: 'stop' }` closes the
 * context — the workers stop, then the pool closes — and exits 0. A crash point exits 137 on its own.
 */

function readTypes(): ChildTypes {
  const raw = process.env[CHILD_TYPES_ENV];
  if (!raw) throw new Error(`${CHILD_TYPES_ENV} is not set`);
  return JSON.parse(raw) as ChildTypes;
}

/** Registers the child's test handlers before the workers start. */
@Injectable()
class ChildHandlers implements OnModuleInit {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(HandlerRegistry) private readonly handlers: HandlerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await ensureHandlerRowsTable(this.db);
    for (const handler of handlersFor(readTypes(), this.db))
      this.handlers.register(handler);
  }
}

@Module({})
class ChildModule {}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const config = parseRuntimeConfig(process.env);
  const logger = createLogger({
    sinks: [consoleSink()],
    secrets: [],
    minLevel: 'info',
  });
  const app = await NestFactory.createApplicationContext(
    {
      module: ChildModule,
      imports: runtimeModules(logger, connectionString, config),
      providers: [ChildHandlers],
    },
    { logger: false, abortOnError: false },
  );

  serveHarness(app, logger, 'child runtime');
}

main().catch((error: unknown) => {
  createLogger({
    sinks: [consoleSink()],
    secrets: [],
    minLevel: 'error',
  }).error('runtime child failed', { error });
  process.exit(1);
});
