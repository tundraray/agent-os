import {
  CALL_RECORD_KINDS,
  type HistoryEntryKind,
  HistoryEntryKindSchema,
  SINGLE_CALL_RECORD_KINDS,
} from '@agent-os/contracts';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { createdAt, isOneOf, searchVector } from './helpers';
import { conversations } from './conversations';

/**
 * The entries a search reads: the texts the feed shows (conversation-search KD-3). Call records, notices,
 * events, compactions and child reports are not searched.
 */
export const SEARCHED_MESSAGE_KINDS = [
  'task',
  'user_message',
  'agent_message',
  'model_answer',
  'tool_result',
] as const satisfies readonly HistoryEntryKind[];

/** The searched text of an entry: `content ->> 'text'`. */
export const messageText = (content: AnyPgColumn): SQL =>
  sql`(${content} ->> 'text')`;

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
    /** The entries a search finds; the condition is `SEARCHED_MESSAGE_KINDS`, word for word. */
    index('messages_text_search_idx')
      .using('gin', searchVector(messageText(t.content)))
      .where(isOneOf(t.kind, SEARCHED_MESSAGE_KINDS)),
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
