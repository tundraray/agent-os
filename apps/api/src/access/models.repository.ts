import {
  modelProvider,
  type CatalogModel,
  type CreateCatalogModelBody,
} from '@agent-os/contracts';
import { accessModelDefaults, accessModels, type Executor } from '@agent-os/db';
import { asc, count, eq, like, sql } from 'drizzle-orm';

/**
 * Drizzle queries of `access_models` and the single `access_model_defaults` row
 * (repository-over-transaction.md): each takes the caller's transaction or the plain client first. Rows
 * are returned as `CatalogModel`, by purpose.
 */

type ModelRow = typeof accessModels.$inferSelect;
type ChatModel = Extract<CatalogModel, { purpose: 'chat' }>;

function toCatalogModel(row: ModelRow): CatalogModel {
  const common = { id: row.id, name: row.name, provider: modelProvider(row.id) };
  if (row.purpose === 'embedding') {
    if (row.dimensions === null)
      throw new Error(`embedding model ${row.id} has no dimensions`);
    return {
      ...common,
      purpose: 'embedding',
      inputUsdPerMTok: row.inputUsdPerMTok,
      dimensions: row.dimensions,
    };
  }
  return {
    ...common,
    purpose: 'chat',
    prices: {
      inputUsdPerMTok: row.inputUsdPerMTok,
      outputUsdPerMTok: row.outputUsdPerMTok,
      cacheWriteUsdPerMTok: row.cacheWriteUsdPerMTok,
      cacheReadUsdPerMTok: row.cacheReadUsdPerMTok,
    },
    longContext: longContextOf(row),
  };
}

/** The long-context tier; the CHECK keeps all five columns set or none. */
function longContextOf(row: ModelRow): ChatModel['longContext'] {
  const {
    longContextAboveInputTokens: aboveInputTokens,
    longContextInputUsdPerMTok: inputUsdPerMTok,
    longContextOutputUsdPerMTok: outputUsdPerMTok,
    longContextCacheWriteUsdPerMTok: cacheWriteUsdPerMTok,
    longContextCacheReadUsdPerMTok: cacheReadUsdPerMTok,
  } = row;
  if (
    aboveInputTokens === null ||
    inputUsdPerMTok === null ||
    outputUsdPerMTok === null ||
    cacheWriteUsdPerMTok === null ||
    cacheReadUsdPerMTok === null
  )
    return null;
  return {
    aboveInputTokens,
    prices: {
      inputUsdPerMTok,
      outputUsdPerMTok,
      cacheWriteUsdPerMTok,
      cacheReadUsdPerMTok,
    },
  };
}

/** The columns a write sets, all but the id: an embedding model has its input price, zeros elsewhere and dimensions (KD-4). */
function columnsOf(model: CreateCatalogModelBody) {
  if (model.purpose === 'embedding')
    return {
      name: model.name,
      purpose: model.purpose,
      inputUsdPerMTok: model.inputUsdPerMTok,
      outputUsdPerMTok: 0,
      cacheWriteUsdPerMTok: 0,
      cacheReadUsdPerMTok: 0,
      longContextAboveInputTokens: null,
      longContextInputUsdPerMTok: null,
      longContextOutputUsdPerMTok: null,
      longContextCacheWriteUsdPerMTok: null,
      longContextCacheReadUsdPerMTok: null,
      dimensions: model.dimensions,
    };
  const long = model.longContext;
  return {
    name: model.name,
    purpose: model.purpose,
    ...model.prices,
    longContextAboveInputTokens: long?.aboveInputTokens ?? null,
    longContextInputUsdPerMTok: long?.prices.inputUsdPerMTok ?? null,
    longContextOutputUsdPerMTok: long?.prices.outputUsdPerMTok ?? null,
    longContextCacheWriteUsdPerMTok: long?.prices.cacheWriteUsdPerMTok ?? null,
    longContextCacheReadUsdPerMTok: long?.prices.cacheReadUsdPerMTok ?? null,
    dimensions: null,
  };
}

export async function findModel(
  executor: Executor,
  id: string,
): Promise<CatalogModel | undefined> {
  const [row] = await executor
    .select()
    .from(accessModels)
    .where(eq(accessModels.id, id));
  return row === undefined ? undefined : toCatalogModel(row);
}

/** The catalogue by name, then id. */
export async function listModels(executor: Executor): Promise<CatalogModel[]> {
  const rows = await executor
    .select()
    .from(accessModels)
    .orderBy(asc(accessModels.name), asc(accessModels.id));
  return rows.map(toCatalogModel);
}

/** How many catalogue models name the provider as the first part of their id (`MODEL_PROVIDER_HAS_MODELS`). */
export async function countByProvider(
  executor: Executor,
  provider: string,
): Promise<number> {
  // A provider name holds only `[a-z0-9-]`, so it has no LIKE wildcard to escape.
  const [row] = await executor
    .select({ models: count() })
    .from(accessModels)
    .where(like(accessModels.id, `${provider}/%`));
  return row?.models ?? 0;
}

/** Adds the model; `undefined` when the id is taken. */
export async function insertModel(
  executor: Executor,
  model: CreateCatalogModelBody,
): Promise<CatalogModel | undefined> {
  const [row] = await executor
    .insert(accessModels)
    .values({ id: model.id, ...columnsOf(model) })
    .onConflictDoNothing({ target: accessModels.id })
    .returning();
  return row === undefined ? undefined : toCatalogModel(row);
}

/** The model locked for an update in the caller's transaction; `undefined` for a missing model. */
export async function lockModel(
  executor: Executor,
  id: string,
): Promise<CatalogModel | undefined> {
  const [row] = await executor
    .select()
    .from(accessModels)
    .where(eq(accessModels.id, id))
    .for('update');
  return row === undefined ? undefined : toCatalogModel(row);
}

/** Writes the model's fields (the id and purpose stay); returns the stored row. */
export async function updateModel(
  executor: Executor,
  model: CatalogModel,
): Promise<CatalogModel> {
  const [row] = await executor
    .update(accessModels)
    .set({ ...columnsOf(model), updatedAt: sql`now()` })
    .where(eq(accessModels.id, model.id))
    .returning();
  if (row === undefined)
    throw new Error('access_models update returned no row');
  return toCatalogModel(row);
}

/** Deletes the model (its grants go by cascade, a default on it is cleared); the deleted model, or `undefined` for a missing one. */
export async function deleteModel(
  executor: Executor,
  id: string,
): Promise<CatalogModel | undefined> {
  const [row] = await executor
    .delete(accessModels)
    .where(eq(accessModels.id, id))
    .returning();
  return row === undefined ? undefined : toCatalogModel(row);
}

// ---------- access_model_defaults ----------

const defaultsColumns = {
  chatModel: accessModelDefaults.chatModel,
  embeddingModel: accessModelDefaults.embeddingModel,
  updatedAt: accessModelDefaults.updatedAt,
  updatedBy: accessModelDefaults.updatedBy,
};

/** The single `access_model_defaults` row; a model id is `null` while none is chosen. */
export interface ModelDefaultsRow {
  chatModel: string | null;
  embeddingModel: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The migration creates the row, so its absence is a fault. */
export async function readModelDefaults(
  executor: Executor,
): Promise<ModelDefaultsRow> {
  const [row] = await executor.select(defaultsColumns).from(accessModelDefaults);
  if (row === undefined) throw new Error('access_model_defaults row is missing');
  return row;
}

/** Writes the administrator's choice with who and when; returns the row after it. */
export async function writeModelDefaults(
  executor: Executor,
  models: { chatModel: string | null; embeddingModel: string | null },
  actorId: string,
): Promise<ModelDefaultsRow> {
  const [row] = await executor
    .update(accessModelDefaults)
    .set({ ...models, updatedAt: new Date(), updatedBy: actorId })
    .returning(defaultsColumns);
  if (row === undefined) throw new Error('access_model_defaults row is missing');
  return row;
}

/** The catalogue row of the default embedding model; `undefined` while none is chosen. */
export async function findDefaultEmbeddingModel(
  executor: Executor,
): Promise<CatalogModel | undefined> {
  const [row] = await executor
    .select({ model: accessModels })
    .from(accessModelDefaults)
    .innerJoin(
      accessModels,
      eq(accessModels.id, accessModelDefaults.embeddingModel),
    );
  return row === undefined ? undefined : toCatalogModel(row.model);
}
