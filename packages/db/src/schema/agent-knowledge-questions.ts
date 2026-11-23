import { real, text, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { conversations } from './conversations';

/**
 * The question of a session and its vector (KD-6). An array, not `vector`: the row is read by key,
 * never searched, so the table does not depend on the extension. Null vector — embeddings refused.
 */
export const agentKnowledgeQuestions = app.table('agent_knowledge_questions', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  /** `task` or the id of the employee's message. */
  source: text('source').notNull(),
  model: text('model'),
  vector: real('vector').array(),
  createdAt: createdAt(),
});
