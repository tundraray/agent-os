import {
  LanguageSchema,
  ScheduleAccessSchema,
  SchedulePauseReasonSchema,
  ScheduleStateSchema,
  ScheduleTargetSchema,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { app } from './app';
import { conversations } from './conversations';
import { createdAt, isOneOf, literal } from './helpers';
import { identityUsers } from './identity-users';

/**
 * An employee's schedule (schedules-search-memory design-schedules.md, Data Model): the instruction, the
 * agent, the rule in its time zone and where a run answers. The rule is checked by `ScheduleRuleSchema` of
 * `@agent-os/contracts`, which the service parses. The conversation it was created in is a key without
 * cascade: a conversation is deleted by a mark.
 */
export const schedules = app.table(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    instruction: text('instruction').notNull(),
    /** The library agent of the chip; null — the chat agent. An agent is deleted by a mark too. */
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
    rule: jsonb('rule').notNull(),
    timeZone: text('time_zone').notNull(),
    /** The language of the day in a new conversation's title (KD-6). */
    language: text('language').notNull(),
    target: text('target').notNull(),
    /** The conversation a `this_conversation` run answers in (chat-scheduling KD-6); null with `new_conversation`. */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** What a run does without a person (chat-scheduling KD-3). */
    access: text('access').notNull().default(ScheduleAccessSchema.enum.read),
    state: text('state').notNull(),
    pausedBecause: text('paused_because'),
    /** The next term; null while paused and once completed (rule 4). */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** The moment `every_hours` terms count from: the rule's creation or last change. */
    ruleSetAt: timestamp('rule_set_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('schedules_owner_idx').on(t.ownerId),
    index('schedules_agent_idx').on(t.agentId),
    index('schedules_conversation_idx').on(t.conversationId),
    /** The pass's read of due terms, earliest first. */
    index('schedules_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.state} = ${literal(ScheduleStateSchema.enum.active)}`),
    check(
      'schedules_language_check',
      isOneOf(t.language, LanguageSchema.options),
    ),
    check(
      'schedules_target_check',
      isOneOf(t.target, ScheduleTargetSchema.options),
    ),
    check(
      'schedules_access_check',
      isOneOf(t.access, ScheduleAccessSchema.options),
    ),
    check(
      'schedules_state_check',
      isOneOf(t.state, ScheduleStateSchema.options),
    ),
    check(
      'schedules_paused_because_check',
      isOneOf(t.pausedBecause, SchedulePauseReasonSchema.options),
    ),
    check(
      'schedules_next_run_check',
      sql`(${t.nextRunAt} is not null) = (${t.state} = ${literal(ScheduleStateSchema.enum.active)})`,
    ),
    check(
      'schedules_pause_reason_state_check',
      sql`${t.pausedBecause} is null or ${t.state} = ${literal(ScheduleStateSchema.enum.paused)}`,
    ),
    check(
      'schedules_target_conversation_check',
      sql`${t.target} <> ${literal(ScheduleTargetSchema.enum.this_conversation)} or ${t.conversationId} is not null`,
    ),
  ],
);
