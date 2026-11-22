import { Db } from './db';
import type { Database } from './database';

/** A database whose `transaction` hands the callback a distinct handle, nested ones included. */
function fakeDatabase(name: string): Database {
  const handle = { name, transaction: (cb: (tx: unknown) => unknown) => cb(fakeDatabase(`${name}>tx`)) };
  return handle as unknown as Database;
}

const nameOf = (client: unknown) => (client as { name: string }).name;

describe('Db', () => {
  it('gives the transaction inside it and the plain database outside and after it', async () => {
    const db = new Db(fakeDatabase('db'));
    expect(nameOf(db.client)).toBe('db');

    let captured = () => '';
    await db.transaction(async () => {
      captured = () => nameOf(db.client);
      expect(captured()).toBe('db>tx');
      // A nested transaction joins the open one, a savepoint nests in it.
      await db.transaction(async () => expect(nameOf(db.client)).toBe('db>tx'));
      await db.savepoint(async () => expect(nameOf(db.client)).toBe('db>tx>tx'));
      expect(nameOf(db.client)).toBe('db>tx');
    });

    expect(captured()).toBe('db');
    expect(nameOf(db.client)).toBe('db');
  });

  it('falls back to the plain database in work that outlives its transaction', async () => {
    const db = new Db(fakeDatabase('db'));
    let late: Promise<string> = Promise.resolve('');
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await db.transaction(async () => {
      late = gate.then(() => nameOf(db.client));
    });
    release();
    expect(await late).toBe('db');
  });
});
