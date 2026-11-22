import { KnowledgeItemKindSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text } from 'drizzle-orm/pg-core';
import { app } from './app';
import { knowledgeItemFields } from './agent-knowledge-item-fields';
import { isOneOf, literal } from './helpers';
import { agentKnowledgeEntities } from './agent-knowledge-entities';

/**
 * A relation: a fact joins two entities of the same graph and goes with either of them
 * (Invariant 6); a lesson and «searched — found nothing» name a tool and a kind of question instead.
 */
export const agentKnowledgeRelations = app.table(
  'agent_knowledge_relations',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    ...knowledgeItemFields(),
    kind: text('kind').notNull(),
    fromEntityId: integer('from_entity_id'),
    toEntityId: integer('to_entity_id'),
    label: text('label'),
    server: text('server'),
    tool: text('tool'),
    question: text('question'),
    hint: text('hint'),
    outcome: text('outcome'),
  },
  (t) => [
    index('agent_knowledge_relations_record_idx').on(t.recordId),
    /** Serve the cascade from an entity. */
    index('agent_knowledge_relations_from_entity_idx').on(t.fromEntityId),
    index('agent_knowledge_relations_to_entity_idx').on(t.toEntityId),
    /** Named: the generated names pass the 63-character limit of Postgres. */
    foreignKey({
      name: 'agent_knowledge_relations_from_entity_fk',
      columns: [t.fromEntityId],
      foreignColumns: [agentKnowledgeEntities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_knowledge_relations_to_entity_fk',
      columns: [t.toEntityId],
      foreignColumns: [agentKnowledgeEntities.id],
    }).onDelete('cascade'),
    /** Invariant 4. */
    check('agent_knowledge_relations_confirmations_check', sql`${t.confirmations} >= 1`),
    check('agent_knowledge_relations_kind_check', isOneOf(t.kind, KnowledgeItemKindSchema.options)),
    check(
      'agent_knowledge_relations_shape_check',
      sql`(${t.kind} = ${literal(KnowledgeItemKindSchema.enum.fact)}
          and ${t.fromEntityId} is not null and ${t.toEntityId} is not null
          and ${t.label} is not null and ${t.server} is null and ${t.tool} is null
          and ${t.question} is null and ${t.hint} is null and ${t.outcome} is null)
        or (${t.kind} = ${literal(KnowledgeItemKindSchema.enum.lesson)}
          and ${t.fromEntityId} is null and ${t.toEntityId} is null and ${t.label} is null
          and ${t.server} is not null and ${t.tool} is not null and ${t.question} is not null
          and ${t.hint} is not null and ${t.outcome} is not null)
        or (${t.kind} = ${literal(KnowledgeItemKindSchema.enum.searched_nothing)}
          and ${t.fromEntityId} is null and ${t.toEntityId} is null and ${t.label} is null
          and ${t.server} is not null and ${t.tool} is not null and ${t.question} is not null
          and ${t.hint} is null and ${t.outcome} is null)`,
    ),
  ],
);
