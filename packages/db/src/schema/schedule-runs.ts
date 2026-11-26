import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { conversations } from './conversations';
import { createdAt } from './helpers';
import { schedules } from './schedules';

/**
 * The history of a schedule (schedules-search-memory design-schedules.md, Data Model): one row per trigger, written
 * in the transaction that sent the instruction and never changed (rule 3). The conversation key has no cascade — a
 * conversation is deleted by a mark — and is null when the send was refused (rule 2).
 */
export const scheduleRuns = app.table(
  'schedule_runs',
  {
    id: uuid('id').primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    /** The term; a manual trigger's — the moment it was asked for. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    manual: boolean('manual').notNull().default(false),
    /** The conversation the instruction went to. */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    createdAt: createdAt(),
  },
  (t) => [
    /** Rule 1: one row per term of a schedule, manual triggers aside. */
    uniqueIndex('schedule_runs_term_idx')
      .on(t.scheduleId, t.dueAt)
      .where(sql`not ${t.manual}`),
    /** The history page, latest terms first. */
    index('schedule_runs_page_idx').on(
      t.scheduleId,
      t.dueAt.desc(),
      t.id.desc(),
    ),
    index('schedule_runs_conversation_idx').on(t.conversationId),
  ],
);
