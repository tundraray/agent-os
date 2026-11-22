import { sql } from 'drizzle-orm';
import { boolean, check, index, unique, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { identityRoles } from './identity-roles';
import { identityUsers } from './identity-users';
import { libraryRecords } from './library-records';

/** A holder of a record's audience: exactly one of a role, an employee or everyone. */
export const libraryShares = app.table(
  'library_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => libraryRecords.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').references(() => identityRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => identityUsers.id, { onDelete: 'cascade' }),
    everyone: boolean('everyone').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('library_shares_record_holder_key')
      .on(t.recordId, t.roleId, t.userId, t.everyone)
      .nullsNotDistinct(),
    index('library_shares_role_idx').on(t.roleId),
    index('library_shares_user_idx').on(t.userId),
    check(
      'library_shares_holder_check',
      sql`num_nonnulls(${t.roleId}, ${t.userId}, nullif(${t.everyone}, false)) = 1`,
    ),
  ],
);
