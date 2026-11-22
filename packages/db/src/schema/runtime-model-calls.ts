import { index, integer, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';

/** Token ledger (KD-5): one row per model call; no FK to the task, so rows outlive the tree. */
export const runtimeModelCalls = app.table(
  'runtime_model_calls',
  {
    callId: uuid('call_id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    /** Task that made the call; null for a call outside a task. */
    taskId: uuid('task_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    costUsd: numeric('cost_usd', {
      precision: 18,
      scale: 9,
      mode: 'number',
    }).notNull(),
    /** Time of the record; the month of a call is counted by UTC. */
    calledAt: timestamp('called_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('runtime_model_calls_owner_called_idx').on(t.ownerId, t.calledAt)],
);
