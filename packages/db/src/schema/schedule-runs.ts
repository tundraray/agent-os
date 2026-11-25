import {
  ScheduleRunOutcomeSchema,
  ScheduleRunStatusSchema,
  ScheduleSkipReasonSchema,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { conversations } from './conversations';
import { createdAt, isOneOf } from './helpers';
import { schedules } from './schedules';

/**
 * The history of a schedule (schedules-search-memory design-schedules.md, Data Model): one row per term, a run
 * or a skip with its reason. A `starting` row's id is the id of the new conversation it will start (KD-2); the
 * conversation key is written when the row becomes `started`, since that conversation does not exist before.
 * Conversation keys have no cascade: a conversation is deleted by a mark.
 */
export const scheduleRuns = app.table(
  'schedule_runs',
  {
    id: uuid('id').primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    /** The term; a manual run's — the moment it was asked for. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    manual: boolean('manual').notNull().default(false),
    outcome: text('outcome').notNull(),
    skipReason: text('skip_reason'),
    /** The conversation of a started run. */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** On a `previous_run_unfinished` skip: the conversation of that unfinished run. */
    unfinishedConversationId: uuid('unfinished_conversation_id').references(
      () => conversations.id,
    ),
    /** The run's message in its conversation's queue (`runtime_inbox.seq`); null when it is the task of a new one. */
    messageSeq: bigint('message_seq', { mode: 'number' }),
    /** The status written once, when the next run of the schedule starts (rule 3). */
    finalStatus: text('final_status'),
    createdAt: createdAt(),
  },
  (t) => [
    /** Rule 1: one row per term of a schedule, manual runs aside. */
    uniqueIndex('schedule_runs_term_idx')
      .on(t.scheduleId, t.dueAt)
      .where(sql`not ${t.manual}`),
    /** The history page, latest terms first. */
    index('schedule_runs_page_idx').on(
      t.scheduleId,
      t.dueAt.desc(),
      t.id.desc(),
    ),
    /** The rows the pass brings to an end first. */
    index('schedule_runs_starting_idx')
      .on(t.id)
      .where(sql`${t.outcome} = 'starting'`),
    index('schedule_runs_conversation_idx').on(t.conversationId),
    index('schedule_runs_unfinished_conversation_idx').on(
      t.unfinishedConversationId,
    ),
    check(
      'schedule_runs_outcome_check',
      isOneOf(t.outcome, ScheduleRunOutcomeSchema.options),
    ),
    check(
      'schedule_runs_skip_reason_check',
      isOneOf(t.skipReason, ScheduleSkipReasonSchema.options),
    ),
    check(
      'schedule_runs_final_status_check',
      isOneOf(t.finalStatus, ScheduleRunStatusSchema.options),
    ),
    check(
      'schedule_runs_skip_check',
      sql`(${t.skipReason} is not null) = (${t.outcome} = 'skipped')`,
    ),
    check(
      'schedule_runs_conversation_check',
      sql`(${t.conversationId} is not null) = (${t.outcome} = 'started')`,
    ),
    check(
      'schedule_runs_final_status_started_check',
      sql`${t.finalStatus} is null or ${t.outcome} = 'started'`,
    ),
  ],
);
