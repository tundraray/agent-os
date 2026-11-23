import {
  CALL_RECORD_KINDS,
  HistoryEntryKindSchema,
  SINGLE_CALL_RECORD_KINDS,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { conversations } from './conversations';

/**
 * History of an agent: append-only, `seq` grows within the session. A tool call is an item of its
 * `model_answer`; what happened to it are later rows keyed by `call_id` — nothing is updated in place.
 */
export const messages = app.table(
  'messages',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    content: jsonb('content').notNull(),
    /** The call a call record is about (`CALL_RECORD_KINDS`); null for every other kind. */
    callId: text('call_id'),
    /** When the call of a `tool_result` ended: the window and the order of the extraction input. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.seq] }),
    index('messages_call_idx').on(t.conversationId, t.callId),
    /** A call has at most one result, one confirmation request, one decision and one intent. */
    uniqueIndex('messages_call_once_idx')
      .on(t.conversationId, t.callId, t.kind)
      .where(isOneOf(t.kind, SINGLE_CALL_RECORD_KINDS)),
    /** The results of a task by end time: the extraction window and the count of started runs. */
    index('messages_result_idx')
      .on(t.conversationId, t.finishedAt)
      .where(
        sql`${t.kind} = ${literal(HistoryEntryKindSchema.enum.tool_result)}`,
      ),
    check(
      'messages_kind_check',
      isOneOf(t.kind, HistoryEntryKindSchema.options),
    ),
    check(
      'messages_call_id_check',
      sql`(${t.callId} is not null) = (${isOneOf(t.kind, CALL_RECORD_KINDS)})`,
    ),
    check(
      'messages_finished_at_check',
      sql`(${t.finishedAt} is not null) = (${t.kind} = ${literal(HistoryEntryKindSchema.enum.tool_result)})`,
    ),
  ],
);
