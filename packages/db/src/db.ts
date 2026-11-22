import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from './database';
import { DATABASE } from './db.tokens';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A transaction of this async context; `closed` once it has committed or rolled back. */
interface OpenTransaction {
  readonly tx: Transaction;
  closed: boolean;
}

/**
 * The database the repositories query through. A service that needs several writes together wraps
 * them in {@link Db.transaction}; the repositories called inside join it by themselves.
 */
@Injectable()
export class Db {
  private readonly current = new AsyncLocalStorage<OpenTransaction>();

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** The transaction open in this async context, otherwise the plain database. */
  get client(): Database | Transaction {
    const open = this.current.getStore();
    return open && !open.closed ? open.tx : this.database;
  }

  /** Runs `fn` in a transaction: joins the one open here, otherwise opens one and commits or rolls it back. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.client === this.database ? this.open(fn) : fn();
  }

  /**
   * Runs `fn` in a savepoint of the transaction open here: a failure of `fn` rolls back only its
   * own writes. With no transaction open it is a transaction of its own.
   */
  savepoint<T>(fn: () => Promise<T>): Promise<T> {
    return this.open(fn);
  }

  private open<T>(fn: () => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      const open: OpenTransaction = { tx, closed: false };
      try {
        return await this.current.run(open, fn);
      } finally {
        open.closed = true;
      }
    });
  }
}
