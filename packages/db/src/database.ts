import type { Logger } from '@agent-os/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

/** Drizzle client typed with the model of schema `app`. */
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  connectionString: string;
  /** Upper bound of the pool's connections (`DB_POOL_MAX` of Runtime Settings). */
  poolMax: number;
  /** How long a caller waits for a free connection before `connect` fails; unset waits without a limit. */
  connectionTimeoutMillis?: number;
}

/** The application's single `pg.Pool` and the Drizzle client over it (KD-7). */
export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
  /** Ends the pool; the composition root calls it after the runtime workers have stopped. */
  close(): Promise<void>;
}

/**
 * Opens the pool and the Drizzle client. Settings come as parameters: the package reads no
 * environment (ADR-0004), and it neither checks nor applies migrations on its own.
 */
export function createDatabase(options: DatabaseOptions): DatabaseConnection {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  });
  return {
    db: drizzle({ client: pool, schema }),
    pool,
    close: () => pool.end(),
  };
}

/**
 * Logs the errors of the pool's clients. A pooled client has no `error` listener while it is
 * checked out, so a session the server ends (the `idle_in_transaction_session_timeout` of a bounded
 * transaction) would crash the process. The query in flight still fails, and the pool replaces the
 * client.
 */
export function logClientErrors(pool: pg.Pool, logger: Logger): void {
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.warn('database client error', { error });
    });
  });
}
