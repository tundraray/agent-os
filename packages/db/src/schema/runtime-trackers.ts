import { TrackerStatusSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { runtimeTasks } from './runtime-tasks';

/**
 * Task trackers (deep-agents/design-task.md, Data Model): a step's commit opens one with its child
 * tasks, and the end of the last of them finishes it with one `tasks_finished` to the owner task.
 * Written only by the runtime, under the lock of the owner task's row.
 */
export const runtimeTrackers = app.table(
  'runtime_trackers',
  {
    trackerId: uuid('tracker_id').primaryKey(),
    /** The task whose step opened the tracker: the parent of its tasks. */
    taskId: uuid('task_id')
      .notNull()
      .references((): AnyPgColumn => runtimeTasks.taskId, { onDelete: 'cascade' }),
    /** The employee who owns the task. */
    ownerId: text('owner_id').notNull(),
    status: text('status').notNull().default(TrackerStatusSchema.enum.open),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('runtime_trackers_status_check', isOneOf(t.status, TrackerStatusSchema.options)),
    /** A task has at most one open tracker. */
    uniqueIndex('runtime_trackers_open_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} = ${literal(TrackerStatusSchema.enum.open)}`),
    /** `trackers.list` and the cascade from the task; the partial index covers only open ones. */
    index('runtime_trackers_task_idx').on(t.taskId),
  ],
);
