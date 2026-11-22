import { SessionTaskStatusSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';
import { agentSessions } from './agent-sessions';

/**
 * The task list of a session (deep-agents/design-task-list.md, KD-1, Data Model): one row per task, keyed by
 * the session and the task's number, which `agent_sessions.last_task_number` gives and never gives again.
 * `blocked_by` holds numbers of the same list. Written in the step transaction with the `tool_result` that
 * changed it; deleting the session deletes its tasks.
 */
export const agentSessionTasks = app.table(
  'agent_session_tasks',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    activeForm: text('active_form'),
    status: text('status')
      .notNull()
      .default(SessionTaskStatusSchema.enum.pending),
    owner: text('owner'),
    blockedBy: integer('blocked_by')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.number] }),
    check(
      'agent_session_tasks_status_check',
      isOneOf(t.status, SessionTaskStatusSchema.options),
    ),
  ],
);
