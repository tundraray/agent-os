// self-learning / core - contract of the `KnowledgeVectorStore` port, one table against real pgvector (Task 3.3)
// Design Doc: docs/features/self-learning/design-core.md - KD-8, Contract `KnowledgeVectorStore`, Invariants 10, 11, FR-19, AC-19.1.
// Run with `pnpm --filter @agent-os/agents test:e2e`: needs Postgres with the `vector` extension (`pgvector/pgvector:pg16`).
//
// The rows speak only the port: the same table runs against any other implementation by swapping `createStore`.
// Each row gets two fresh deep agents (`a`, `b`) with real `app.agents` rows; `withLibraryRow` deletes their knowledge
// rows itself and only marks the agents deleted.
// Vectors are unit length; model B's are of another length, so a query that compared across models would fail in pgvector.
import { randomUUID } from 'node:crypto';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  KnowledgeVector,
  KnowledgeVectorStore,
} from '../src/knowledge/vector-store';
import { databaseUrl } from '@agent-os/db/testing';
import { createPgvectorStore, withLibraryRow } from './support/knowledge';

const MODEL_A = 'test-embed/model-a';
const MODEL_B = 'test-embed/model-b';

/** Model A's graph: two entities and a relation at closeness 1, 0.6 and 0 to `[1, 0, 0]`, and an entity of model B. */
const GRAPH: readonly KnowledgeVector[] = [
  { key: 'e1', kind: 'entity', model: MODEL_A, vector: [1, 0, 0] },
  { key: 'e2', kind: 'entity', model: MODEL_A, vector: [0.6, 0.8, 0] },
  { key: 'r3', kind: 'relation', model: MODEL_A, vector: [0, 1, 0] },
  { key: 'e4', kind: 'entity', model: MODEL_B, vector: [1, 0] },
];

const QUESTION = [1, 0, 0];

interface ContractRow {
  readonly name: string;
  /** Arranges and acts through the port on deep agents `a` and `b`; returns what is asserted. */
  readonly act: (
    store: KnowledgeVectorStore,
    a: string,
    b: string,
  ) => Promise<unknown>;
  readonly expected: unknown;
}

const ROWS: readonly ContractRow[] = [
  {
    // Catches: a second row per key, or the old model kept with the new vector (Invariant 11).
    name: 'upsert of the same key replaces vector and model, the key stays one',
    act: async (store, a) => {
      await store.upsert(a, [
        { key: 'e1', kind: 'entity', model: MODEL_A, vector: [1, 0, 0] },
      ]);
      await store.upsert(a, [
        { key: 'e1', kind: 'entity', model: MODEL_B, vector: [0, 1] },
      ]);
      return {
        list: await store.list(a),
        newModel: await store.query(a, [0, 1], MODEL_B, 10),
        oldModel: await store.query(a, QUESTION, MODEL_A, 10),
      };
    },
    expected: {
      list: [{ key: 'e1', kind: 'entity', model: MODEL_B }],
      newModel: [{ key: 'e1', closeness: 1 }],
      oldModel: [],
    },
  },
  {
    // Catches: closeness that is not the cosine, a wrong order, a vector of another model compared (Invariant 11), `limit` ignored.
    name: 'query gives cosine closeness, closest first, of this model only, up to limit',
    act: async (store, a) => {
      await store.upsert(a, GRAPH);
      return {
        all: await store.query(a, QUESTION, MODEL_A, 10),
        limited: await store.query(a, QUESTION, MODEL_A, 2),
        otherModel: await store.query(a, [1, 0], MODEL_B, 10),
      };
    },
    expected: {
      all: [
        { key: 'e1', closeness: 1 },
        { key: 'e2', closeness: 0.6 },
        { key: 'r3', closeness: 0 },
      ],
      limited: [
        { key: 'e1', closeness: 1 },
        { key: 'e2', closeness: 0.6 },
      ],
      otherModel: [{ key: 'e4', closeness: 1 }],
    },
  },
  {
    // Catches: similar-entity search spending its places on relations (KD-8, `kind` filter).
    name: 'query with kind entity returns no relations',
    act: async (store, a) => {
      await store.upsert(a, GRAPH);
      return store.query(a, [0, 1, 0], MODEL_A, 10, 'entity');
    },
    expected: [
      { key: 'e2', closeness: 0.8 },
      { key: 'e1', closeness: 0 },
    ],
  },
  {
    // Catches: a deleted record's vector left behind (Invariant 10), a pass failing on a key already gone.
    name: 'delete removes the keys, an unknown key is not an error',
    act: async (store, a) => {
      await store.upsert(a, GRAPH);
      await store.delete(a, ['e2', 'e99']);
      return store.list(a);
    },
    expected: [
      { key: 'e1', kind: 'entity', model: MODEL_A },
      { key: 'e4', kind: 'entity', model: MODEL_B },
      { key: 'r3', kind: 'relation', model: MODEL_A },
    ],
  },
  {
    // Catches: list missing a key or its model, so a pass would not find vectors of an old model or of deleted records.
    name: 'list gives every key with its kind and model',
    act: async (store, a) => {
      await store.upsert(a, GRAPH);
      return store.list(a);
    },
    expected: [
      { key: 'e1', kind: 'entity', model: MODEL_A },
      { key: 'e2', kind: 'entity', model: MODEL_A },
      { key: 'e4', kind: 'entity', model: MODEL_B },
      { key: 'r3', kind: 'relation', model: MODEL_A },
    ],
  },
  {
    // Catches: one deep agent's vectors seen, found or deleted through another's collection.
    name: "another deep agent's collection is not visible",
    act: async (store, a, b) => {
      await store.upsert(b, GRAPH);
      await store.upsert(a, [
        { key: 'e1', kind: 'entity', model: MODEL_A, vector: [0, 1, 0] },
      ]);
      await store.delete(a, ['e2', 'r3']);
      return {
        listA: await store.list(a),
        queryA: await store.query(a, QUESTION, MODEL_A, 10),
        listB: (await store.list(b)).map((item) => item.key),
      };
    },
    expected: {
      listA: [{ key: 'e1', kind: 'entity', model: MODEL_A }],
      queryA: [{ key: 'e1', closeness: 0 }],
      listB: ['e1', 'e2', 'e4', 'r3'],
    },
  },
];

/** pgvector keeps `real` components: closeness is compared to five decimals. */
function rounded(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1e5) / 1e5 + 0;
  if (Array.isArray(value)) return value.map(rounded);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rounded(item)]),
    );
  return value;
}

describe('KnowledgeVectorStore contract (pgvector)', () => {
  let database: DatabaseConnection;
  let createStore: () => KnowledgeVectorStore;

  beforeAll(() => {
    database = createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
    createStore = () => createPgvectorStore(database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  it.each(ROWS)('$name', async ({ act, expected }) => {
    const a = randomUUID();
    const b = randomUUID();
    const result = await withLibraryRow(database.db, a, () =>
      withLibraryRow(database.db, b, () => act(createStore(), a, b)),
    );
    expect(rounded(result)).toEqual(expected);
  });
});
