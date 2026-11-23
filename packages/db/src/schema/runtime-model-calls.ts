import {
  index,
  integer,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { identityUsers } from './identity-users';
import { runtimeTasks } from './runtime-tasks';

/** Token ledger (KD-5): one row per model call; the task's FK sets null, so rows outlive the tree. */
export const runtimeModelCalls = app.table(
  'runtime_model_calls',
  {
    callId: uuid('call_id').primaryKey(),
    /** The employee whose spend it is; null for the platform's own calls, which no employee's month counts. */
    ownerId: uuid('owner_id').references(() => identityUsers.id, {
      onDelete: 'cascade',
    }),
    /** Task that made the call; null for a call outside a task or after its tree was deleted. */
    taskId: uuid('task_id').references(() => runtimeTasks.taskId, {
      onDelete: 'set null',
    }),
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
  (t) => [
    index('runtime_model_calls_owner_called_idx').on(t.ownerId, t.calledAt),
    /** The `set null` from a deleted task. */
    index('runtime_model_calls_task_idx').on(t.taskId),
  ],
);
