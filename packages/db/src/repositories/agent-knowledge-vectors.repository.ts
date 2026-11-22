import { type KnowledgeItemType, KnowledgeItemTypeSchema } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, cosineDistance, eq, inArray, sql } from 'drizzle-orm';
import { Db } from '../db';
import { agentKnowledgeVectors } from '../schema';

const vectors = agentKnowledgeVectors;

/** A record's vector to write: its key, kind, the model that computed the vector, and the vector. */
export interface NewKnowledgeVectorRow {
  readonly key: string;
  readonly kind: KnowledgeItemType;
  readonly model: string;
  readonly vector: readonly number[];
}

/**
 * Drizzle queries of `agent_knowledge_vectors` in the platform's Postgres with pgvector (KD-8): the
 * first store of the graph's vectors, in the shape of the agents' `KnowledgeVectorStore`. Search is
 * exact cosine over the rows of one collection and one model, no approximate index; vectors are unit
 * length, so closeness `1 - cosine distance` equals their dot product.
 */
@Injectable()
export class AgentKnowledgeVectorsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}


  async upsert(collection: string, items: readonly NewKnowledgeVectorRow[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.client
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
  }

  async delete(collection: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db.client
      .delete(vectors)
      .where(and(eq(vectors.recordId, collection), inArray(vectors.key, [...keys])));
  }

  query(
    collection: string,
    vector: readonly number[],
    model: string,
    limit: number,
    kind?: KnowledgeItemType,
  ): Promise<{ key: string; closeness: number }[]> {
    // A bound parameter (`'[…]'` text) that Postgres types as `vector` by the operator's left side.
    const distance = cosineDistance(vectors.vector, [...vector]);
    // pgvector cannot compare vectors of different lengths, so the model filter is never optional.
    return this.db.client
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
  }

  async list(
    collection: string,
  ): Promise<{ key: string; kind: KnowledgeItemType; model: string }[]> {
    const rows = await this.db.client
      .select({ key: vectors.key, kind: vectors.keyKind, model: vectors.model })
      .from(vectors)
      .where(eq(vectors.recordId, collection))
      .orderBy(asc(vectors.key));
    return rows.map((row) => ({ ...row, kind: KnowledgeItemTypeSchema.parse(row.kind) }));
  }
}
