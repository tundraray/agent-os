import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { runtimeTasks } from './runtime-tasks';

export const agentSessions = app.table(
  'agent_sessions',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    /**
     * The task's parent and root, copied from `runtime_tasks` when the row is written (a root names
     * itself as its root), so the chain reads from this table. No FK: the row is deleted by the cascade
     * of `task_id` alone.
     */
    parentId: uuid('parent_id'),
    rootId: uuid('root_id').notNull(),
    /** Owner of the task. */
    ownerId: text('owner_id').notNull(),
    /**
     * Set only on a root session, which the owner sees as a conversation: its title (empty until one
     * is written) and its last change, the key of the owner's list. Null on every other session.
     */
    title: text('title'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Name of the run from its snapshot (custom-agents/design-runtime.md, KD-3). */
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Model of the snapshot; every call of the session uses it. */
    model: text('model').notNull(),
    /** Task text; `restart` starts a new agent with it. */
    prompt: text('prompt').notNull(),
    /**
     * Origin of the run: the library record it started from, as it was at the start; a root session
     * carries the builtin record `chat`. No FK: the record may be deleted. The snapshot itself lives
     * only in the task input (ADR-0017).
     */
    recordId: uuid('record_id').notNull(),
    recordKind: text('record_kind').notNull(),
    recordVersion: integer('record_version').notNull(),
    recordName: text('record_name').notNull(),
    authorId: uuid('author_id'),
    authorName: text('author_name'),
    builtinKey: text('builtin_key'),
    /** Subagent name of a run of a subagent; null otherwise. */
    subagent: text('subagent'),
    /** The owner had no earlier session with this record. */
    firstRun: boolean('first_run').notNull().default(false),
    /** Fork source: the parent's history up to `forked_through_seq` precedes this one. No FK. */
    forkedFromTaskId: uuid('forked_from_task_id'),
    forkedThroughSeq: integer('forked_through_seq'),
    turns: integer('turns').notNull().default(0),
    interrupted: boolean('interrupted').notNull().default(false),
    /** Set when the agent itself finished (`complete` or `fail`). */
    closed: boolean('closed').notNull().default(false),
    /** Input tokens of the last model call; drives compaction. */
    lastInputTokens: integer('last_input_tokens'),
    /**
     * The last number given to a task of the session's list (deep-agents design-task-list.md, KD-1); never
     * goes back, so a deleted task's number is not given again.
     */
    lastTaskNumber: integer('last_task_number').notNull().default(0),
    createdAt: createdAt(),
    /** Set only on the root session of a deleted conversation, which answers as a missing one. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /** Counts the owner's runs of a record for the chat listing. */
    index('agent_sessions_owner_record_idx').on(t.ownerId, t.recordId),
    index('agent_sessions_root_idx').on(t.rootId),
    /** The owner's conversations, last changed first; the condition is the agents' `isRoot`. */
    index('agent_sessions_owner_page_idx')
      .on(t.ownerId, t.updatedAt.desc(), t.taskId.desc())
      .where(sql`${t.updatedAt} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);
