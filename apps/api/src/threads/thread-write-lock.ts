import { Logger } from '@nestjs/common';
import { withFields } from '../common/log-fields.js';

/** One connection of the thread lock pool: the statements of a lock's transaction and the return to the pool. */
export interface ThreadLockClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  /** With an error the pool destroys the connection, and Postgres ends its transaction and its locks. */
  release(error?: Error): void;
}

/** The thread lock pool (`THREAD_LOCK_POOL`): its own connections, so waiting for one never stalls work under a lock. */
export interface ThreadLockPool {
  connect(): Promise<ThreadLockClient>;
}

/**
 * The whole wait for a thread lock: the wait for a lock pool connection and the wait for the lock share it
 * (design-lifecycle.md, KD-5). The pool's `connectionTimeoutMillis` is this value.
 */
export const THREAD_LOCK_WAIT_MS = 15_000;

/**
 * First key of `pg_advisory_xact_lock(int4, int4)`: the class of thread locks; the second key is `hashtext` of the
 * thread id. The two-key space does not overlap the single-bigint one of the migration lock.
 */
export const THREAD_LOCK_NAMESPACE = 1_952_998_507;

/**
 * The thread lock was not obtained: no lock pool connection in time, no time left for the lock after the connection,
 * or the lock not granted within `lock_timeout`. One error for all three, which callers treat as a database failure.
 */
export class ThreadLockNotObtainedError extends Error {
  constructor(key: string, reason: string, options?: ErrorOptions) {
    super(`thread lock of ${key} not obtained: ${reason}`, options);
    this.name = 'ThreadLockNotObtainedError';
  }
}

export interface ThreadWriteLockOptions {
  /** A monotonic clock in milliseconds; measures the time the connection wait took from the shared limit. */
  now?: () => number;
}

/**
 * Serialises async tasks per key (a `threadId`) across every API instance (design-lifecycle.md, KD-5). Within the
 * process tasks of one key queue first, so a key takes at most one lock pool connection here; each task then takes a
 * transaction-level advisory lock of Postgres on a lock pool connection and runs `fn` on its own connections. The end
 * of `fn` ends the lock's transaction: a rejected `fn` rolls it back, which frees the lock at once. Tasks of different
 * keys run in parallel; a key's in-process tail is removed once its last queued task settles, so the map does not grow.
 */
export class ThreadWriteLock {
  private readonly logger = new Logger(ThreadWriteLock.name);
  /** Per key: a promise that settles (never rejects) when the last queued task settles. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(
    private readonly pool: ThreadLockPool,
    options: ThreadWriteLockOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.underAdvisoryLock(key, fn));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Whether a task of this key is running or queued in this process. */
  isHeld(key: string): boolean {
    return this.tails.has(key);
  }

  private async underAdvisoryLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const client = await this.acquire(key);
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      await this.endTransaction(client, key, 'ROLLBACK');
      throw error;
    }
    await this.endTransaction(client, key, 'COMMIT');
    return result;
  }

  /** A lock pool connection in an open transaction holding the key's lock, or {@link ThreadLockNotObtainedError}. */
  private async acquire(key: string): Promise<ThreadLockClient> {
    const waitStartedAt = this.now();
    let client: ThreadLockClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ThreadLockNotObtainedError(key, 'no lock pool connection', {
        cause: error,
      });
    }
    const remainingMs = Math.floor(
      THREAD_LOCK_WAIT_MS - (this.now() - waitStartedAt),
    );
    // `lock_timeout = 0` lifts the limit in Postgres, so a remainder under 1 ms is never requested.
    if (remainingMs < 1) {
      client.release();
      throw new ThreadLockNotObtainedError(key, 'no time left for the lock');
    }
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${remainingMs}ms`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        THREAD_LOCK_NAMESPACE,
        key,
      ]);
      return client;
    } catch (error) {
      await this.endTransaction(client, key, 'ROLLBACK');
      throw new ThreadLockNotObtainedError(key, 'lock not granted in time', {
        cause: error,
      });
    }
  }

  /**
   * Ends the lock's transaction and returns the connection. When the statement fails the connection is destroyed
   * instead, and Postgres ends the transaction and frees the lock with it; the transaction carries no writes, so the
   * outcome of `fn` stands and the failure is only logged.
   */
  private async endTransaction(
    client: ThreadLockClient,
    key: string,
    statement: 'COMMIT' | 'ROLLBACK',
  ): Promise<void> {
    try {
      await client.query(statement);
      client.release();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      client.release(failure);
      this.logger.warn(
        withFields('thread lock transaction end failed, connection destroyed', {
          threadId: key,
          statement,
          error: failure.message,
        }),
      );
    }
  }
}
