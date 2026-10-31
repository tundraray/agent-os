import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { assertNoPendingMigrations } from './pending-migrations.js';
import {
  loadRuntimeConfig,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from './runtime-config.js';
import * as schema from './schema.js';

/**
 * DI token of the application's single `pg.Pool` (KD-7).
 * @public consumed by the research runtime data layer
 */
export const PG_POOL = Symbol('PG_POOL');
/**
 * DI token of the Drizzle client over {@link PG_POOL}, typed with the `app` schema model.
 * @public consumed by the research runtime data layer
 */
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Global database access: Runtime Settings, the pool and the Drizzle client. On start it only
 * checks the migration files against the journal (ADR-0003) — it never applies migrations — and
 * fails the start naming the pending files. The pool is closed last, in `onApplicationShutdown`.
 */
@Global()
@Module({
  providers: [
    {
      provide: RUNTIME_CONFIG,
      useFactory: loadRuntimeConfig,
      inject: [ConfigService],
    },
    {
      provide: PG_POOL,
      useFactory: (config: ConfigService, runtime: RuntimeConfig) =>
        new pg.Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: runtime.dbPoolMax,
        }),
      inject: [ConfigService, RUNTIME_CONFIG],
    },
    {
      provide: DRIZZLE,
      useFactory: (pool: pg.Pool): Database =>
        drizzle({ client: pool, schema }),
      inject: [PG_POOL],
    },
  ],
  exports: [RUNTIME_CONFIG, PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onModuleInit(): Promise<void> {
    await assertNoPendingMigrations(this.pool);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
