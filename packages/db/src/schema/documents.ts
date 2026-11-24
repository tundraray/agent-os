import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { conversations } from './conversations';

/**
 * Millisecond times pass through a JS `Date` unchanged, so `updated_at` read by a tool matches the row in
 * the guarded write (`DocumentsRepository.updateText`).
 */
const time = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();

/**
 * A document of a deep agent run's notepad (self-learning design-notepad.md KD-1, Data Model): it belongs to
 * the run's conversation; `updated_by` is the conversation of the run member who wrote last.
 */
export const documents = app.table(
  'documents',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    text: text('text').notNull(),
    report: boolean('report').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (t) => [
    index('documents_conversation_idx').on(t.conversationId),
    /** The cascade from the writer's conversation. */
    index('documents_updated_by_idx').on(t.updatedBy),
  ],
);
