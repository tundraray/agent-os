import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

/** Drizzle client typed with the model of schema `app`. */
export type Database = NodePgDatabase<typeof schema>;

/** A transaction of {@link Database}: what a write that must commit with its caller's writes takes. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What a repository runs its queries on (repository-over-transaction.md): the caller's transaction
 * or the plain client. A function that takes it may run outside a transaction; one that must not
 * takes {@link Transaction}.
 */
export type Executor = Database | Transaction;

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
