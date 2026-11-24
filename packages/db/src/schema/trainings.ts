import type { Comparison } from '@agent-os/contracts';
import {
  index,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { agentVersions } from './agent-versions';
import { app } from './app';
import { conversations } from './conversations';
import { identityUsers } from './identity-users';

/**
 * One training of one agent (self-learning design-training.md, KD-6, Data Model). The id is the training's
 * conversation and root `trainer` task; who started it and when are theirs. Conversation ids in `comparisons`
 * have no foreign key — the ADR-0024 exception of KD-6: conversations are never deleted physically.
 */
export const trainings = app.table(
  'trainings',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    baseVersionId: uuid('base_version_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'cascade' }),
    capUsd: numeric('cap_usd', {
      precision: 18,
      scale: 9,
      mode: 'number',
    }).notNull(),
    /** When the budget stopped the training at its cap; null — it did not. */
    cappedAt: timestamp('capped_at', { withTimezone: true }),
    /** Explanations of the proposed version's changes; null while there is no version. */
    changes: text('changes'),
    /** Up to 5 elements in order. */
    comparisons: jsonb('comparisons').$type<Comparison[]>().notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedBy: uuid('activated_by').references(() => identityUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('trainings_agent_idx').on(t.agentId),
    index('trainings_base_version_idx').on(t.baseVersionId),
    index('trainings_activated_by_idx').on(t.activatedBy),
  ],
);
