import type { Comparison, TestRunPlan, TestRunTest } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
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
    /** Empty only in a test run before its agent is created (design-test-run.md, Data Model). */
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
    baseVersionId: uuid('base_version_id').references(() => agentVersions.id, {
      onDelete: 'cascade',
    }),
    capUsd: numeric('cap_usd', {
      precision: 18,
      scale: 9,
      mode: 'number',
    }).notNull(),
    /** When the budget stopped the training at its cap; null — it did not. */
    cappedAt: timestamp('capped_at', { withTimezone: true }),
    /** Up to 5 elements in order. */
    comparisons: jsonb('comparisons').$type<Comparison[]>().notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedBy: uuid('activated_by').references(() => identityUsers.id, {
      onDelete: 'set null',
    }),
    /** The employee's description; set — the row is a test run. */
    description: text('description'),
    /** A test run's tests, up to 5 in order; a training's list is empty. */
    tests: jsonb('tests').$type<TestRunTest[]>().notNull().default([]),
    /** A test run's latest plan (design-trainer-dialog.md, KD-3); null before the first one. */
    plan: jsonb('plan').$type<TestRunPlan>(),
    /** The agent the trainer offered instead of a new one (KD-4). */
    offeredAgentId: uuid('offered_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /** The offered agent the employee took (KD-5); set — the test run is over. */
    takenAgentId: uuid('taken_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /** The conversation with the taken agent the take created, once (KD-5). */
    takenThreadId: uuid('taken_thread_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check(
      'trainings_agent_check',
      sql`(${t.agentId} is null) = (${t.baseVersionId} is null)`,
    ),
    index('trainings_agent_idx').on(t.agentId),
    index('trainings_base_version_idx').on(t.baseVersionId),
    index('trainings_activated_by_idx').on(t.activatedBy),
    index('trainings_offered_agent_idx').on(t.offeredAgentId),
    index('trainings_taken_agent_idx').on(t.takenAgentId),
    index('trainings_taken_thread_idx').on(t.takenThreadId),
  ],
);
