/**
 * Usage of one call as the provider reported it: `inputTokens` is the whole input, the cached
 * parts included; `outputTokens` includes thinking; `cacheReadTokens` and `cacheWriteTokens` are
 * the cached parts of the input.
 */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Rates in USD per million tokens. */
interface PriceRates {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheWriteUsdPerMTok: number;
  readonly cacheReadUsdPerMTok: number;
}

/**
 * Price of one model, with an optional tier above an input size. It comes with the call from the
 * model catalogue (ADR-0015); the runtime keeps no prices.
 */
export interface ModelPrice extends PriceRates {
  readonly above?: PriceRates & {
    /** The tier applies when the whole input of a call is larger than this. */
    readonly inputTokens: number;
  };
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * Cost of one call in USD (KD-5). The tier `above` applies when the whole input is larger than its
 * `inputTokens`; uncached input, cache write, cache read and output are priced at their own rates.
 */
export function callCostUsd(price: ModelPrice, usage: CallUsage): number {
  const rates: PriceRates =
    price.above !== undefined && usage.inputTokens > price.above.inputTokens
      ? price.above
      : price;
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const microUsd =
    uncachedInput * rates.inputUsdPerMTok +
    usage.cacheWriteTokens * rates.cacheWriteUsdPerMTok +
    usage.cacheReadTokens * rates.cacheReadUsdPerMTok +
    usage.outputTokens * rates.outputUsdPerMTok;
  return microUsd / TOKENS_PER_PRICE_UNIT;
}
