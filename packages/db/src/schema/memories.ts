import { sql } from 'drizzle-orm';
import { check, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { app } from './app';
import { createdAt } from './helpers';
import { identityUsers } from './identity-users';

/** A memory record of a self-learning deep agent: owned by exactly one agent or one employee (KD-1). */
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
    text: text('text').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** NULLs are distinct, so each index binds only its own owner and serves as an `ON CONFLICT` target. */
    uniqueIndex('memories_agent_description_idx').on(t.agentId, t.description),
    uniqueIndex('memories_user_description_idx').on(t.userId, t.description),
    check(
      'memories_owner_check',
      sql`num_nonnulls(${t.agentId}, ${t.userId}) = 1`,
    ),
  ],
);
