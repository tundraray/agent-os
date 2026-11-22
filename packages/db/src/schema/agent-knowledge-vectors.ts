import { KnowledgeItemTypeSchema } from '@agent-os/contracts';
import { check, customType, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf } from './helpers';
import { libraryRecords } from './library-records';

/** pgvector column without a fixed length (KD-8); the type lives where the extension is installed. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value): number[] => JSON.parse(value) as number[],
});

/**
 * The pgvector store of `KnowledgeVectorStore` (KD-8): the collection is the deep agent, one vector
 * per record key, carrying its model (Invariant 11).
 */
export const agentKnowledgeVectors = app.table(
  'agent_knowledge_vectors',
  {
    recordId: uuid('record_id')
      .notNull()
      .references(() => libraryRecords.id, { onDelete: 'cascade' }),
    /** Record key: `e12`, `r7`. */
    key: text('key').notNull(),
    keyKind: text('key_kind').notNull(),
    model: text('model').notNull(),
    vector: vector('vector').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.key] }),
    check(
      'agent_knowledge_vectors_key_kind_check',
      isOneOf(t.keyKind, KnowledgeItemTypeSchema.options),
    ),
  ],
);
