import { sql } from 'drizzle-orm';
import { boolean, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';

export const identityRoles = app.table(
  'identity_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    trainOwn: boolean('train_own').notNull().default(false),
    trainAny: boolean('train_any').notNull().default(false),
    /** The built-in «Супер-администратор»: created by the migration, never changed (KD-6). */
    builtin: boolean('builtin').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('identity_roles_name_idx').on(sql`lower(${t.name})`)],
);
