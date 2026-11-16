import type {
  CatalogModel,
  PriceRates,
  UpdateCatalogModelBody,
} from '@agent-os/contracts';
import { accessModels } from '@agent-os/db';
import { asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../common/executor.js';

/**
 * Drizzle queries of `access_models` (repository-over-transaction.md): each takes the caller's
 * transaction or the plain client first. Rows are returned as `CatalogModel`.
 */

type ModelRow = typeof accessModels.$inferSelect;

/** The catalogue fields a write sets: all but the id. */
type CatalogFields = Omit<CatalogModel, 'id'>;

function toCatalogModel(row: ModelRow): CatalogModel {
  const prices: PriceRates = {
    inputUsdPerMTok: row.inputUsdPerMTok,
    outputUsdPerMTok: row.outputUsdPerMTok,
    cacheWriteUsdPerMTok: row.cacheWriteUsdPerMTok,
    cacheReadUsdPerMTok: row.cacheReadUsdPerMTok,
  };
  return {
    id: row.id,
    name: row.name,
    prices,
    longContext: longContextOf(row),
  };
}

/** The long-context tier; the CHECK keeps all five columns set or none. */
function longContextOf(row: ModelRow): CatalogModel['longContext'] {
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

function columnsOf(fields: CatalogFields) {
  const long = fields.longContext;
  return {
    name: fields.name,
    ...fields.prices,
    longContextAboveInputTokens: long?.aboveInputTokens ?? null,
    longContextInputUsdPerMTok: long?.prices.inputUsdPerMTok ?? null,
    longContextOutputUsdPerMTok: long?.prices.outputUsdPerMTok ?? null,
    longContextCacheWriteUsdPerMTok: long?.prices.cacheWriteUsdPerMTok ?? null,
    longContextCacheReadUsdPerMTok: long?.prices.cacheReadUsdPerMTok ?? null,
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

/** Adds the model; `undefined` when the id is taken. */
export async function insertModel(
  executor: Executor,
  model: CatalogModel,
): Promise<CatalogModel | undefined> {
  const [row] = await executor
    .insert(accessModels)
    .values({ id: model.id, ...columnsOf(model) })
    .onConflictDoNothing({ target: accessModels.id })
    .returning();
  return row === undefined ? undefined : toCatalogModel(row);
}

/** Changes the given fields; «было» and «стало», or `undefined` for a missing model. */
export async function updateModel(
  executor: Executor,
  id: string,
  change: UpdateCatalogModelBody,
): Promise<{ before: CatalogModel; after: CatalogModel } | undefined> {
  const [current] = await executor
    .select()
    .from(accessModels)
    .where(eq(accessModels.id, id))
    .for('update');
  if (current === undefined) return undefined;
  const before = toCatalogModel(current);
  const fields: CatalogFields = {
    name: change.name ?? before.name,
    prices: change.prices ?? before.prices,
    longContext:
      change.longContext === undefined
        ? before.longContext
        : change.longContext,
  };
  const [row] = await executor
    .update(accessModels)
    .set({ ...columnsOf(fields), updatedAt: sql`now()` })
    .where(eq(accessModels.id, id))
    .returning();
  if (row === undefined)
    throw new Error('access_models update returned no row');
  return { before, after: toCatalogModel(row) };
}

/** Deletes the model (its grants go by cascade); the deleted model, or `undefined` for a missing one. */
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
