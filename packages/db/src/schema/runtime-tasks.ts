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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { identityUsers } from './identity-users';

const { queued, running, waiting } = TaskStatusSchema.enum;

export const runtimeTasks = app.table(
  'runtime_tasks',
  {
    taskId: uuid('task_id').primaryKey(),
    type: text('type').notNull(),
    /** The employee the tree runs for; null for the platform's own work without an owner, which nobody sees. */
    ownerId: uuid('owner_id').references(() => identityUsers.id, {
      onDelete: 'cascade',
    }),
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
    /**
     * Losses of the current step found by the sweeper; 0 after its outcome, an interrupt and a
     * requeue on shutdown. Above 0 a claimed step continues a lost one (`resumedAfterLoss`).
     */
    recoveries: integer('recoveries').notNull().default(0),
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
    /**
     * The parent's `step_no` after the commit that created this child, set once when the parent
     * waits for it (data-model/design-runtime.md, KD-2); null for a background child.
     */
    awaitedStep: integer('awaited_step'),
    /** An opaque string of the creator: one unfinished task of a type holds it at a time; null — none. */
    exclusiveKey: text('exclusive_key'),
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
    /** Children of a task, and the count of a waiting parent's unfinished awaited children. */
    index('runtime_tasks_parent_idx').on(t.parentId),
    /** An end status takes the task out of the index: the key is free again without a write. */
    uniqueIndex('runtime_tasks_exclusive_key_idx')
      .on(t.type, t.exclusiveKey)
      .where(
        sql`${t.exclusiveKey} is not null and ${isOneOf(t.status, [queued, running, waiting])}`,
      ),
  ],
);
