import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { app } from './app';
import { createdAt } from './helpers';
import { identityUsers } from './identity-users';
import { memoryVersions } from './memory-versions';

/**
 * A memory record of a self-learning deep agent: owned by exactly one agent or one employee (self-learning KD-1).
 * Its texts live only in its immutable versions; the row points to the current one (memory-hygiene KD-1).
 */
export const memories = app.table(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => identityUsers.id, {
      onDelete: 'cascade',
    }),
    description: text('description').notNull(),
    /** Null only inside the transaction that inserts the record and its version 1. */
    currentVersion: integer('current_version'),
    createdAt: createdAt(),
  },
  (t) => [
    /** NULLs are distinct, so each index binds only its own owner and serves as an `ON CONFLICT` target. */
    uniqueIndex('memories_agent_description_idx').on(t.agentId, t.description),
    uniqueIndex('memories_user_description_idx').on(t.userId, t.description),
    check(
      'memories_owner_check',
      sql`num_nonnulls(${t.agentId}, ${t.userId}) = 1`,
    ),
    /**
     * The pointer names only a version of this record. NO ACTION, not restrict: it is checked at the end of the
     * statement, so erasing the record takes the versions it points to with it by cascade.
     */
    foreignKey({
      name: 'memories_current_version_fk',
      columns: [t.id, t.currentVersion],
      foreignColumns: [memoryVersions.memoryId, memoryVersions.version],
    }),
  ],
);
