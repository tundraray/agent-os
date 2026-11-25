import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { agentVersions } from './agent-versions';
import { createdAt } from './helpers';
import { identityUsers } from './identity-users';
import { runtimeTasks } from './runtime-tasks';

export const conversations = app.table(
  'conversations',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    /**
     * The conversation of the agent that started this one; null on a root — the only mark of a root
     * (data-model design-schema.md KD-1). An unchanging copy of the task's parent, kept here for the
     * partial index of the owner's list.
     */
    parentId: uuid('parent_id').references(
      (): AnyPgColumn => conversations.id,
      {
        onDelete: 'cascade',
      },
    ),
    /** The employee the whole tree runs for; an unchanging copy of the task's owner. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    /**
     * The tool call in the parent's conversation that started this one; set exactly when `parent_id` is.
     * No FK: a call is an item of a model answer, not a row.
     */
    startCallId: text('start_call_id'),
    /**
     * Set only on a root, which the owner sees as a conversation: its title (empty until one is written)
     * and its last change, the key of the owner's list. Null on every other conversation.
     */
    title: text('title'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /**
     * The version the conversation started on (data-model design-agents.md, KD-6): the one copy of its
     * definition. Never changes; the version is never deleted while a conversation points at it.
     */
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'restrict' }),
    /** Name of the run: the agent's, the team member's or the one a call gave a temporary agent. */
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** The model the start chose (KD-3); every call of the session uses it. */
    model: text('model').notNull(),
    /** The team member of a deep agent's version a subagent run is; null otherwise. */
    subagent: text('subagent'),
    /** The owner had no earlier conversation on a version of the same agent. */
    firstRun: boolean('first_run').notNull().default(false),
    /**
     * Entries up to this one are inherited: a subagent reads them from its parent, a forked root holds a copy
     * of its source's.
     */
    forkedThroughSeq: integer('forked_through_seq'),
    /** The conversation a forked root was copied from; set only on a root, together with `forked_through_seq`. */
    forkedFromId: uuid('forked_from_id').references(
      (): AnyPgColumn => conversations.id,
      { onDelete: 'set null' },
    ),
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
  },
  (t) => [
    /** The owner's runs of an agent through its versions: the first-run mark and the chat listing's counts. */
    index('conversations_owner_version_idx').on(t.ownerId, t.agentVersionId),
    /** The past tasks of an agent across every owner (self-learning design-training.md, KD-2). */
    index('conversations_agent_version_idx').on(t.agentVersionId),
    /** The cascade from a parent conversation. */
    index('conversations_parent_idx').on(t.parentId),
    /** The forks of a conversation. */
    index('conversations_forked_from_idx').on(t.forkedFromId),
    /** The owner's conversations, last changed first; the condition is the repository's `isRoot`. */
    index('conversations_owner_page_idx')
      .on(t.ownerId, t.updatedAt.desc(), t.id.desc())
      .where(sql`${t.parentId} IS NULL`),
    check(
      'conversations_start_call_check',
      sql`(${t.startCallId} is not null) = (${t.parentId} is not null)`,
    ),
    check(
      'conversations_root_check',
      sql`(${t.title} is not null) = (${t.parentId} is null) and (${t.updatedAt} is not null) = (${t.parentId} is null)`,
    ),
    check(
      'conversations_fork_check',
      sql`${t.forkedFromId} is null or (${t.parentId} is null and ${t.forkedThroughSeq} is not null)`,
    ),
  ],
);
