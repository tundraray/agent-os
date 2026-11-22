import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertNoPendingMigrations,
  DATABASE_CONNECTION,
  type DatabaseConnection,
} from '@agent-os/db';
import { RuntimeModule } from '@agent-os/runtime';
import { readRuntimeSettings } from './runtime-settings';

/**
 * Composition root of the runtime in `apps/api` (composition-root.md, design-runtime.md C2 `api`): reads
 * the settings from the environment for `RuntimeModule`, which works over the pool of `DbModule` with
 * the application logger and the system clock. Upper modules register their handlers and event
 * consumers in their `onModuleInit`.
 *
 * Phases: `onModuleInit` — the migration check (never applies, ADR-0003); `onApplicationBootstrap` — the
 * workers start (`RuntimeWorkers`); `beforeApplicationShutdown` — the workers stop; the pool
 * closes after it, in `onApplicationShutdown` of `DbModule`.
 */
@Module({
  imports: [
    RuntimeModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readRuntimeSettings((name) => config.get<string>(name)),
    }),
  ],
})
export class ApiRuntimeModule implements OnModuleInit {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
  ) {}

  async onModuleInit(): Promise<void> {
    await assertNoPendingMigrations(this.database.pool);
  }
}
