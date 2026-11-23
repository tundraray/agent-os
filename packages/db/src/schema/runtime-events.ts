import { EVENT_PAYLOAD_MAX_BYTES } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { runtimeTasks } from './runtime-tasks';

export const runtimeEvents = app.table(
  'runtime_events',
  {
    eventId: uuid('event_id').primaryKey(),
    /** Insertion order only; carries no meaning across trees. */
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** Root of the tree: the correlation of every event of the tree. */
    rootId: uuid('root_id')
      .notNull()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => runtimeTasks.taskId, {
      onDelete: 'cascade',
    }),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'runtime_events_payload_size_check',
      sql`octet_length(${t.payload}::text) <= ${sql.raw(String(EVENT_PAYLOAD_MAX_BYTES))}`,
    ),
    index('runtime_events_root_seq_idx').on(t.rootId, t.seq),
    /** The cascade from a task that is not the root. */
    index('runtime_events_task_idx').on(t.taskId),
  ],
);
