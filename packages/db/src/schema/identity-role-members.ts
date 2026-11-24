import { index, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { identityRoles } from './identity-roles';
import { identityUsers } from './identity-users';

export const identityRoleMembers = app.table(
  'identity_role_members',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => identityRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.userId] }),
    index('identity_role_members_user_idx').on(t.userId),
  ],
);
