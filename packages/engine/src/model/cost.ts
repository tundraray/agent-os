import type {
  ModelCatalogEntry,
  ModelPriceTier,
} from '../config/model-catalog.js';

/**
 * Usage of one call as the provider reported it (C3): `inputTokens` is the whole input, the
 * cached parts included; `outputTokens` includes thinking; `cacheReadTokens` and
 * `cacheWriteTokens` are the cached parts of the input.
 */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Tokens a settled call charges to the budgets: the whole input plus the output. */
export function chargedTokens(usage: CallUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Cost of one call in USD by the catalog (AC-11.1). The tier is chosen by the whole input of the
 * request; uncached input, cache write, cache read and output are priced at their own rates.
 */
export function callCostUsd(entry: ModelCatalogEntry, usage: CallUsage): number {
  const tier = tierFor(entry, usage.inputTokens);
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const microUsd =
    uncachedInput * tier.inputUsdPerMTok +
    usage.cacheWriteTokens * tier.cacheWriteUsdPerMTok +
    usage.cacheReadTokens * tier.cacheReadUsdPerMTok +
    usage.outputTokens * tier.outputUsdPerMTok;
  return microUsd / TOKENS_PER_PRICE_UNIT;
}

function tierFor(entry: ModelCatalogEntry, inputTokens: number): ModelPriceTier {
  const tier = entry.tiers.find(
    ({ upToInputTokens }) =>
      upToInputTokens === null || inputTokens <= upToInputTokens,
  );
  if (tier === undefined) {
    throw new Error(`no price tier covers ${inputTokens} input tokens`);
  }
  return tier;
}
