import { sql } from 'drizzle-orm';
import { boolean, check, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { accessModels } from './access-models';

/** The single row of the default models (ModelDefaults); the migration creates it. */
export const accessModelDefaults = app.table(
  'access_model_defaults',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    /** Null — not chosen; deleting the model clears the choice (DC-6). */
    chatModel: text('chat_model').references(() => accessModels.id, {
      onDelete: 'set null',
    }),
    embeddingModel: text('embedding_model').references(() => accessModels.id, {
      onDelete: 'set null',
    }),
    /** Null while nothing was changed. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Employee id; null while nothing was changed. */
    updatedBy: text('updated_by'),
  },
  (t) => [check('access_model_defaults_single_row_check', sql`${t.id}`)],
);
