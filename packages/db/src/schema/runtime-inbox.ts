import { MessageStatusSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, text, unique, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { runtimeTasks } from './runtime-tasks';

export const runtimeInbox = app.table(
  'runtime_inbox',
  {
    messageId: uuid('message_id').primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    /** Grows within the recipient and orders delivery. */
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    /** Task or employee that sent the message. */
    sender: text('sender').notNull(),
    payload: jsonb('payload').notNull(),
    /** Queue a finished recipient again. */
    revive: boolean('revive').notNull().default(false),
    status: text('status').notNull().default(MessageStatusSchema.enum.pending),
    /** Step that received the message; null while pending. */
    deliveredStep: integer('delivered_step'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('runtime_inbox_recipient_seq_key').on(t.recipientId, t.seq),
    check(
      'runtime_inbox_status_check',
      isOneOf(t.status, MessageStatusSchema.options),
    ),
    index('runtime_inbox_pending_idx')
      .on(t.recipientId, t.seq)
      .where(sql`${t.status} = ${literal(MessageStatusSchema.enum.pending)}`),
  ],
);
