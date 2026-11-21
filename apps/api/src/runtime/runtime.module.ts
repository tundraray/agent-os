import {
  Inject,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Logger } from '@agent-os/common';
import {
  assertNoPendingMigrations,
  createDatabase,
  type DatabaseConnection,
} from '@agent-os/db';
import {
  createRuntime,
  systemClock,
  type Clock,
  type Runtime,
  type RuntimeConfig,
} from '@agent-os/runtime';
import { APP_LOGGER } from '../logging/app-logger';
import { readRuntimeSettings } from './runtime-settings';
import {
  RUNTIME,
  RUNTIME_CLOCK,
  RUNTIME_DATABASE,
  RUNTIME_SETTINGS,
} from './runtime.tokens';

/**
 * Composition root of the runtime in `apps/api` (composition-root.md, design-runtime.md C2 `api`): reads
 * the settings, opens the pool and assembles the runtime with the application logger
 * and the system clock. Upper modules register handlers on `RUNTIME` in their `onModuleInit`.
 *
 * Phases: `onModuleInit` — the migration check (never applies, ADR-0003); `onApplicationBootstrap` — the
 * workers start; `beforeApplicationShutdown` — the workers stop; `onApplicationShutdown` — the pool closes.
 */
@Module({
  providers: [
    {
      provide: RUNTIME_SETTINGS,
      useFactory: (config: ConfigService): RuntimeConfig =>
        readRuntimeSettings((name) => config.get<string>(name)),
      inject: [ConfigService],
    },
    {
      provide: RUNTIME_DATABASE,
      useFactory: (
        config: ConfigService,
        settings: RuntimeConfig,
      ): DatabaseConnection =>
        createDatabase({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          poolMax: settings.dbPoolMax,
        }),
      inject: [ConfigService, RUNTIME_SETTINGS],
    },
    { provide: RUNTIME_CLOCK, useValue: systemClock },
    {
      provide: RUNTIME,
      useFactory: (
        database: DatabaseConnection,
        settings: RuntimeConfig,
        clock: Clock,
        logger: Logger,
      ): Runtime =>
        createRuntime({ database, config: settings, logger, clock }),
      inject: [RUNTIME_DATABASE, RUNTIME_SETTINGS, RUNTIME_CLOCK, APP_LOGGER],
    },
  ],
  exports: [RUNTIME, RUNTIME_DATABASE, RUNTIME_CLOCK, RUNTIME_SETTINGS],
})
export class RuntimeModule
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  constructor(
    @Inject(RUNTIME_DATABASE) private readonly database: DatabaseConnection,
    @Inject(RUNTIME) private readonly runtime: Runtime,
  ) {}

  async onModuleInit(): Promise<void> {
    await assertNoPendingMigrations(this.database.pool);
  }

  onApplicationBootstrap(): void {
    this.runtime.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}
