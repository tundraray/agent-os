import { sql } from 'drizzle-orm';
import { check, index, integer, text } from 'drizzle-orm/pg-core';
import { app } from './app';
import { knowledgeItemFields } from './agent-knowledge-item-fields';

/** An entity of a deep agent's graph: always a fact. */
export const agentKnowledgeEntities = app.table(
  'agent_knowledge_entities',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    ...knowledgeItemFields(),
    name: text('name').notNull(),
    description: text('description').notNull(),
  },
  (t) => [
    index('agent_knowledge_entities_record_idx').on(t.recordId),
    /** Invariant 4. */
    check(
      'agent_knowledge_entities_confirmations_check',
      sql`${t.confirmations} >= 1`,
    ),
  ],
);
