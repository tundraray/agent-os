import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertNoPendingMigrations,
  createDatabase,
  type DatabaseConnection,
} from '@agent-os/db';
import {
  type Clock,
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  systemClock,
} from '@agent-os/runtime';
import { ThreadDeletionHooks } from '../threads/thread-deletion-hooks.js';
import { ThreadsModule } from '../threads/threads.module.js';
import { ThreadsService } from '../threads/threads.service.js';
import { NestRuntimeLogger } from './nest-runtime-logger.js';
import {
  HANDLER_REGISTRY,
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
  RUNTIME_CLOCK,
} from './research.tokens.js';
import { runtimeSettingsVariables } from './runtime-settings.js';

/**
 * Runtime Settings parsed from the environment. Exported for `EngineModule`, which passes their `leaseMs` to
 * `createEngine` and checks the agent deadline margin against it (design-agent-core.md, Runtime Settings).
 */
export const RUNTIME_SETTINGS = Symbol('RUNTIME_SETTINGS');

/**
 * Composition root of the research runtime (ADR-0001, ADR-0004): it reads the environment,
 * opens the pool with `createDatabase`, builds the runtime with `createRuntime` and binds it to
 * the Nest phases (KD-7). `ThreadsService` is the `ThreadOwnership` port, and the thread deletion
 * hook is registered here (KD-5), so `threads` depends on nothing of the runtime.
 *
 * Phases: `onModuleInit` — the migration check (never applies, ADR-0003) and the deletion hook;
 * `onApplicationBootstrap` — `start` (workers only when `RUNTIME_WORKERS=on`);
 * `beforeApplicationShutdown` — `stop`; `onApplicationShutdown` — the pool closes last.
 */
@Module({
  imports: [ThreadsModule],
  providers: [
    {
      provide: RUNTIME_SETTINGS,
      useFactory: (config: ConfigService): RuntimeConfig =>
        parseRuntimeConfig(
          runtimeSettingsVariables((name) => config.get<string>(name)),
        ),
      inject: [ConfigService],
    },
    {
      provide: RESEARCH_DATABASE,
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
      provide: RESEARCH_RUNTIME,
      useFactory: (
        database: DatabaseConnection,
        settings: RuntimeConfig,
        threads: ThreadsService,
        clock: Clock,
      ): Runtime =>
        createRuntime({
          database,
          config: settings,
          threads,
          logger: new NestRuntimeLogger('ResearchRuntime'),
          clock,
        }),
      inject: [
        RESEARCH_DATABASE,
        RUNTIME_SETTINGS,
        ThreadsService,
        RUNTIME_CLOCK,
      ],
    },
    {
      provide: HANDLER_REGISTRY,
      useFactory: (runtime: Runtime) => runtime.handlers,
      inject: [RESEARCH_RUNTIME],
    },
  ],
  exports: [
    RESEARCH_RUNTIME,
    HANDLER_REGISTRY,
    RUNTIME_CLOCK,
    RESEARCH_DATABASE,
    RUNTIME_SETTINGS,
  ],
})
export class ResearchModule
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  constructor(
    @Inject(RESEARCH_DATABASE) private readonly database: DatabaseConnection,
    @Inject(RESEARCH_RUNTIME) private readonly runtime: Runtime,
    private readonly deletionHooks: ThreadDeletionHooks,
  ) {}

  async onModuleInit(): Promise<void> {
    await assertNoPendingMigrations(this.database.pool);
    const { investigations } = this.runtime;
    this.deletionHooks.register({
      stop: (ref, window) => investigations.stopThread(ref, window),
      purge: (ref) => investigations.purgeThread(ref),
    });
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
