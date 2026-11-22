import { TaskStatusSchema, WaitReasonSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { runtimeTrackers } from './runtime-trackers';

export const runtimeTasks = app.table(
  'runtime_tasks',
  {
    taskId: uuid('task_id').primaryKey(),
    type: text('type').notNull(),
    ownerId: text('owner_id').notNull(),
    parentId: uuid('parent_id').references(
      (): AnyPgColumn => runtimeTasks.taskId,
      {
        onDelete: 'cascade',
      },
    ),
    /** The root of the tree; a root task references itself. */
    rootId: uuid('root_id')
      .notNull()
      .references((): AnyPgColumn => runtimeTasks.taskId, {
        onDelete: 'cascade',
      }),
    /** The root has depth 0. */
    depth: integer('depth').notNull(),
    input: jsonb('input').notNull(),
    status: text('status').notNull().default(TaskStatusSchema.enum.queued),
    /** Set exactly while the task is `waiting`. */
    waitReason: text('wait_reason'),
    /** Committed steps of the task. */
    stepNo: integer('step_no').notNull().default(0),
    /** Number of the current claim; fences a step that is no longer current. */
    attempt: integer('attempt').notNull().default(0),
    /** Claims of the current step; 0 after its outcome. */
    stepClaims: integer('step_claims').notNull().default(0),
    /** Losses of the current step found by the sweeper; 0 after its outcome. */
    recoveries: integer('recoveries').notNull().default(0),
    /** Next number in the task's inbox. */
    nextMessageSeq: integer('next_message_seq').notNull().default(0),
    result: jsonb('result'),
    /** `{ reason, message }` of a `failed` task. */
    failure: jsonb('failure'),
    createdAt: createdAt(),
    /** Insertion order only: orders tasks created in one transaction, which share `created_at`. */
    createdSeq: bigint('created_seq', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Set on every task of a deleted tree, which answers as a missing one; null otherwise. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The tracker the task belongs to, set when a step's commit opened it; null otherwise. */
    trackerId: uuid('tracker_id').references(
      (): AnyPgColumn => runtimeTrackers.trackerId,
      {
        onDelete: 'cascade',
      },
    ),
  },
  (t) => [
    check(
      'runtime_tasks_status_check',
      isOneOf(t.status, TaskStatusSchema.options),
    ),
    check(
      'runtime_tasks_wait_reason_check',
      isOneOf(t.waitReason, WaitReasonSchema.options),
    ),
    check(
      'runtime_tasks_waiting_check',
      sql`(${t.status} = ${literal(TaskStatusSchema.enum.waiting)}) = (${t.waitReason} is not null)`,
    ),
    /** The claim: the oldest `queued` task of the registered types, in this order. */
    index('runtime_tasks_ready_idx')
      .on(t.createdAt, t.taskId)
      .where(sql`${t.status} = ${literal(TaskStatusSchema.enum.queued)}`),
    index('runtime_tasks_root_idx').on(t.rootId),
    index('runtime_tasks_parent_idx').on(t.parentId),
    /** The end of a tracker's task counts the tracker's unfinished tasks. */
    index('runtime_tasks_tracker_idx').on(t.trackerId),
  ],
);
