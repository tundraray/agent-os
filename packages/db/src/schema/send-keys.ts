import { primaryKey, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { identityUsers } from './identity-users';

/**
 * A send key an employee's send took (runtime-fixes design-send.md, Data Model, KD-1): written first in
 * the send's transaction, so a retry with the same key finds the row and creates nothing. The primary key
 * starts with the employee and serves as the index of the reference.
 */
export const sendKeys = app.table(
  'send_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    sendKey: uuid('send_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sendKey] })],
);
