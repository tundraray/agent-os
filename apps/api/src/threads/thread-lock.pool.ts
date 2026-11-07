import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { parseRuntimeConfig } from '@agent-os/runtime';
import { runtimeSettingsVariables } from '../research/runtime-settings.js';
import { THREAD_LOCK_WAIT_MS } from './thread-write-lock.js';

/** The thread lock pool (design-lifecycle.md, KD-5): a `DatabaseConnection` of its own, closed by `ThreadsModule`. */
export const THREAD_LOCK_POOL = Symbol('THREAD_LOCK_POOL');

/**
 * Opens the thread lock pool over the main pool's database. Its size is `DB_POOL_MAX`, read by the same parse of
 * Runtime Settings as the main pool (no setting of its own), so an instance holds up to 2 × `DB_POOL_MAX`
 * connections. A caller waits for a free connection at most {@link THREAD_LOCK_WAIT_MS}, the limit the lock wait
 * shares. Only the pure settings parse comes from the runtime package, never the runtime or its ports.
 */
export const threadLockPoolProvider: FactoryProvider<DatabaseConnection> = {
  provide: THREAD_LOCK_POOL,
  useFactory: (config: ConfigService): DatabaseConnection =>
    createDatabase({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      poolMax: parseRuntimeConfig(
        runtimeSettingsVariables((name) => config.get<string>(name)),
      ).dbPoolMax,
      connectionTimeoutMillis: THREAD_LOCK_WAIT_MS,
    }),
  inject: [ConfigService],
};
