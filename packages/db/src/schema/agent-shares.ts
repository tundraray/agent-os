import { sql } from 'drizzle-orm';
import { boolean, check, index, unique, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { agents } from './agents';
import { createdAt } from './helpers';
import { identityRoles } from './identity-roles';
import { identityUsers } from './identity-users';

/** A holder of an agent's audience: exactly one of a role, an employee or everyone. */
export const agentShares = app.table(
  'agent_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').references(() => identityRoles.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => identityUsers.id, {
      onDelete: 'cascade',
    }),
    everyone: boolean('everyone').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('agent_shares_agent_holder_key')
      .on(t.agentId, t.roleId, t.userId, t.everyone)
      .nullsNotDistinct(),
    index('agent_shares_role_idx').on(t.roleId),
    index('agent_shares_user_idx').on(t.userId),
    check(
      'agent_shares_holder_check',
      sql`num_nonnulls(${t.roleId}, ${t.userId}, nullif(${t.everyone}, false)) = 1`,
    ),
  ],
);
