import {
  modelProvider,
  type CatalogModel,
  type CreateCatalogModelBody,
} from '@agent-os/contracts';
import type { ModelColumns, ModelRow } from '@agent-os/db';

type ChatModel = Extract<CatalogModel, { purpose: 'chat' }>;

/** A row of `models` as a catalogue model, by purpose. */
export function toCatalogModel(row: ModelRow): CatalogModel {
  const common = {
    id: row.id,
    name: row.name,
    provider: modelProvider(row.id),
  };
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

/** The catalogue model of a row that may be missing. */
export function toCatalogModelOrUndefined(
  row: ModelRow | undefined,
): CatalogModel | undefined {
  return row === undefined ? undefined : toCatalogModel(row);
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
export function modelColumnsOf(model: CreateCatalogModelBody): ModelColumns {
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
