import {
  TrackerAuthorSchema,
  TrackerEventKindSchema,
  TrackerTaskStatusSchema,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { check, index, text, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { conversations } from './conversations';
import { createdAt, isOneOf, literal } from './helpers';
import { trackerTasks } from './tracker-tasks';

/**
 * The comments and status changes of a task (task-tracker design-server.md, Data Model): the only feed entries
 * nothing else holds. A row never changes after its insert (rule 3). The conversation is the one an agent's entry
 * came from or an employee's comment was sent to; nulled when its row goes.
 */
export const trackerTaskEvents = app.table(
  'tracker_task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => trackerTasks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    author: text('author').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** The comment's text; null on a status change. */
    text: text('text'),
    /** The status set; null on a comment. */
    status: text('status'),
    createdAt: createdAt(),
  },
  (t) => [
    /** The task's feed by time. */
    index('tracker_task_events_task_idx').on(t.taskId, t.createdAt),
    index('tracker_task_events_conversation_idx').on(t.conversationId),
    check(
      'tracker_task_events_kind_check',
      isOneOf(t.kind, TrackerEventKindSchema.options),
    ),
    check(
      'tracker_task_events_author_check',
      isOneOf(t.author, TrackerAuthorSchema.options),
    ),
    check(
      'tracker_task_events_status_check',
      isOneOf(t.status, TrackerTaskStatusSchema.options),
    ),
    /** A comment has its text, a status change its status, and neither the other's. */
    check(
      'tracker_task_events_content_check',
      sql`(${t.text} is not null) = (${t.kind} = ${literal(TrackerEventKindSchema.enum.comment)}) and (${t.status} is not null) = (${t.kind} = ${literal(TrackerEventKindSchema.enum.status)})`,
    ),
  ],
);
