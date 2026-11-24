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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';
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
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.seq] }),
    index('messages_call_idx').on(t.conversationId, t.callId),
    /** A call has at most one result, one confirmation request, one decision and one intent. */
    uniqueIndex('messages_call_once_idx')
      .on(t.conversationId, t.callId, t.kind)
      .where(isOneOf(t.kind, SINGLE_CALL_RECORD_KINDS)),
    check(
      'messages_kind_check',
      isOneOf(t.kind, HistoryEntryKindSchema.options),
    ),
    check(
      'messages_call_id_check',
      sql`(${t.callId} is not null) = (${isOneOf(t.kind, CALL_RECORD_KINDS)})`,
    ),
  ],
);
