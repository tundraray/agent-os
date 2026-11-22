import { DecisionStatusSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { runtimeTasks } from './runtime-tasks';

export const runtimeDecisions = app.table(
  'runtime_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    rootId: uuid('root_id').notNull(),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default(DecisionStatusSchema.enum.open),
    resolution: jsonb('resolution'),
    /** Step the decision was handed to; null until then. */
    deliveredStep: integer('delivered_step'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'runtime_decisions_status_check',
      isOneOf(t.status, DecisionStatusSchema.options),
    ),
    /** Invariant 3: a task has at most one open request. */
    uniqueIndex('runtime_decisions_open_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} = ${literal(DecisionStatusSchema.enum.open)}`),
    /** Serves the cascade from the task; the partial index above covers only open requests. */
    index('runtime_decisions_task_idx').on(t.taskId),
    index('runtime_decisions_root_idx').on(t.rootId),
  ],
);
