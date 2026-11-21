import { KnowledgeItemTypeSchema } from '@agent-os/contracts';
import { agentKnowledgeVectors, type Database } from '@agent-os/db';
import { and, asc, cosineDistance, eq, inArray, sql } from 'drizzle-orm';

import type { KnowledgeVectorStore } from './vector-store';

const vectors = agentKnowledgeVectors;

/**
 * The first `KnowledgeVectorStore`: table `agent_knowledge_vectors` in the platform's Postgres with
 * pgvector (KD-8). Search is exact cosine over the rows of one collection and one model, no
 * approximate index; vectors are unit length, so closeness `1 - cosine distance` equals their dot
 * product. Every statement is its own; SQL never leaves this file.
 */
export function createPgvectorStore(database: Database): KnowledgeVectorStore {
  return {
    async upsert(collection, items) {
      if (items.length === 0) return;
      await database
        .insert(vectors)
        .values(
          items.map((item) => ({
            recordId: collection,
            key: item.key,
            keyKind: item.kind,
            model: item.model,
            vector: [...item.vector],
          })),
        )
        .onConflictDoUpdate({
          target: [vectors.recordId, vectors.key],
          set: {
            keyKind: sql`excluded.key_kind`,
            model: sql`excluded.model`,
            vector: sql`excluded.vector`,
          },
        });
    },

    async delete(collection, keys) {
      if (keys.length === 0) return;
      await database
        .delete(vectors)
        .where(and(eq(vectors.recordId, collection), inArray(vectors.key, [...keys])));
    },

    async query(collection, vector, model, limit, kind) {
      // A bound parameter (`'[…]'` text) that Postgres types as `vector` by the operator's left side.
      const distance = cosineDistance(vectors.vector, [...vector]);
      // pgvector cannot compare vectors of different lengths, so the model filter is never optional.
      return database
        .select({ key: vectors.key, closeness: sql<number>`1 - (${distance})`.mapWith(Number) })
        .from(vectors)
        .where(
          and(
            eq(vectors.recordId, collection),
            eq(vectors.model, model),
            kind === undefined ? undefined : eq(vectors.keyKind, kind),
          ),
        )
        .orderBy(distance, asc(vectors.key))
        .limit(limit);
    },

    async list(collection) {
      const rows = await database
        .select({ key: vectors.key, kind: vectors.keyKind, model: vectors.model })
        .from(vectors)
        .where(eq(vectors.recordId, collection))
        .orderBy(asc(vectors.key));
      return rows.map((row) => ({ ...row, kind: KnowledgeItemTypeSchema.parse(row.kind) }));
    },
  };
}
