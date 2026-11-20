import type { KnowledgeItemType } from '@agent-os/contracts';

/**
 * A record's vector in a collection: the key of a graph record (`e12`, `r7`), its kind, the catalogue
 * id of the model that computed the vector, and the vector itself, of unit length.
 */
export interface KnowledgeVector {
  readonly key: string;
  readonly kind: KnowledgeItemType;
  readonly model: string;
  readonly vector: readonly number[];
}

/** A key found by `query` and its closeness to the asked vector: the cosine, from -1 to 1, higher is closer. */
export interface KnowledgeCloseness {
  readonly key: string;
  readonly closeness: number;
}

/** A key held by the collection, its kind and the model of its vector — what a pass compares with the graph. */
export interface KnowledgeVectorKey {
  readonly key: string;
  readonly kind: KnowledgeItemType;
  readonly model: string;
}

/**
 * Replaceable store of the graph's vectors (self-learning/design-core.md, KD-8, FR-19). A collection is
 * the graph of one workflow — its record id. The graph tables are the source of truth: the store
 * shares no transaction with them, a caller joins found keys with the graph and drops keys without a
 * record. Filters are plain fields; a failure of the store is an exception.
 */
export interface KnowledgeVectorStore {
  /** Writes each item's vector, replacing the vector and model the key had: one vector per key (Invariant 11). */
  upsert(collection: string, items: readonly KnowledgeVector[]): Promise<void>;
  /** Removes the keys' vectors; a key the collection does not hold is not an error. */
  delete(collection: string, keys: readonly string[]): Promise<void>;
  /**
   * Up to `limit` keys among the vectors of this `model` only — and of this `kind`, when given — by
   * closeness, closest first. Vectors of other models are never compared (Invariant 11).
   */
  query(
    collection: string,
    vector: readonly number[],
    model: string,
    limit: number,
    kind?: KnowledgeItemType,
  ): Promise<KnowledgeCloseness[]>;
  /** Every key of the collection with its kind and model. */
  list(collection: string): Promise<KnowledgeVectorKey[]>;
}
