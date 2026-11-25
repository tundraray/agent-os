import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { agents } from './agents';
import { createdAt } from './helpers';
import { identityUsers } from './identity-users';
import { trainings } from './trainings';

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
    /** The training or test run that proposed it; a test run proposes one version per fix round. */
    trainingId: uuid('training_id').references(
      (): AnyPgColumn => trainings.id,
      { onDelete: 'set null' },
    ),
    /** Explanations of the changes its training or test run proposed; null for other versions. */
    changes: text('changes'),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_versions_training_idx').on(t.trainingId),
    unique('agent_versions_agent_number_key').on(t.agentId, t.number),
    /** The target of the agent's pointer, so it names only its own version. */
    unique('agent_versions_agent_id_key').on(t.agentId, t.id),
  ],
);
