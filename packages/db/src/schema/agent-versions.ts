import {
  type AnyPgColumn,
  integer,
  jsonb,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { agents } from './agents';
import { createdAt } from './helpers';
import { identityUsers } from './identity-users';

/**
 * An immutable definition of an agent (data-model design-agents.md, KD-1, KD-2): rows are never updated
 * or deleted. `content` is in the form of the agent's kind, checked by the kind's schema in
 * `@agent-os/contracts`.
 */
export const agentVersions = app.table(
  'agent_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references((): AnyPgColumn => agents.id, { onDelete: 'cascade' }),
    /** Next after the greatest number of the agent's versions. */
    number: integer('number').notNull(),
    content: jsonb('content').notNull(),
    /** The employee who saved it; null — not a person (the built-in rows migration). */
    authorId: uuid('author_id').references(() => identityUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('agent_versions_agent_number_key').on(t.agentId, t.number),
    /** The target of the agent's pointer, so it names only its own version. */
    unique('agent_versions_agent_id_key').on(t.agentId, t.id),
  ],
);
