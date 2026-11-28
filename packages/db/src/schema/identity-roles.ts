import {
  BuiltinRoleKindSchema,
  type BuiltinRoleKind,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';

export const identityRoles = app.table(
  'identity_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    trainOwn: boolean('train_own').notNull().default(false),
    trainAny: boolean('train_any').notNull().default(false),
    /** Kind of a built-in role, created by the migration (access-levels KD-5); null for any other role. */
    builtinKind: text('builtin_kind').$type<BuiltinRoleKind>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('identity_roles_name_idx').on(sql`lower(${t.name})`),
    /** At most one role of each built-in kind. */
    uniqueIndex('identity_roles_builtin_kind_idx')
      .on(t.builtinKind)
      .where(sql`${t.builtinKind} is not null`),
    check(
      'identity_roles_builtin_kind_check',
      isOneOf(t.builtinKind, BuiltinRoleKindSchema.options),
    ),
  ],
);
