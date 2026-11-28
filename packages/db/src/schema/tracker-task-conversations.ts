import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { app } from './app';
import { conversations } from './conversations';
import { trackerTasks } from './tracker-tasks';

/**
 * The link of a task with a conversation its delegation opened (task-tracker design-server.md, KD-1, Data Model):
 * written in the delegation's transaction with the conversation's root (rule 1). The conversation is the key — it
 * belongs to at most one task, and its view and `tracker_report` find the task by it. The agent and its name at
 * the delegation are both null for the chat agent; the agent's key is nulled when its row goes, the name stays.
 */
export const trackerTaskConversations = app.table(
  'tracker_task_conversations',
  {
    conversationId: uuid('conversation_id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => trackerTasks.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    agentName: text('agent_name'),
    delegatedAt: timestamp('delegated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** The task's conversations, the latest delegation first: its live one to forward to. */
    index('tracker_task_conversations_task_idx').on(
      t.taskId,
      t.delegatedAt.desc(),
    ),
    index('tracker_task_conversations_agent_idx').on(t.agentId),
  ],
);
