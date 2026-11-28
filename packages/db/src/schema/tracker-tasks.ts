import { TrackerTaskStatusSchema } from '@agent-os/contracts';
import { check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';
import { identityUsers } from './identity-users';

/**
 * An employee's own task (task-tracker design-server.md, Data Model): title, description and status. Goes with
 * the employee by cascade; a delete is physical and takes the task's links and feed with it (KD-7).
 */
export const trackerTasks = app.table(
  'tracker_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull(),
    createdAt: createdAt(),
    /** The last change: an edit, a status, a comment, a delegation or a report. */
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** The owner's list, recently changed first. */
    index('tracker_tasks_owner_updated_idx').on(
      t.ownerId,
      t.updatedAt.desc(),
      t.id.desc(),
    ),
    check(
      'tracker_tasks_status_check',
      isOneOf(t.status, TrackerTaskStatusSchema.options),
    ),
  ],
);
