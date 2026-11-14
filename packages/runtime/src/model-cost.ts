import { z } from 'zod';

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

const usdPerMTok = z.number().min(0);

const PriceRatesSchema = z.object({
  inputUsdPerMTok: usdPerMTok,
  outputUsdPerMTok: usdPerMTok,
  cacheWriteUsdPerMTok: usdPerMTok,
  cacheReadUsdPerMTok: usdPerMTok,
});

/** Price of one model in USD per million tokens, with an optional tier above an input size. */
const ModelPriceSchema = PriceRatesSchema.extend({
  above: PriceRatesSchema.extend({
    /** The tier applies when the whole input of a call is larger than this. */
    inputTokens: z.number().int().positive(),
  }).optional(),
});

/** The prices file (`MODEL_PRICES_FILE`): `{ "<provider/model>": ModelPrice }`, at least one model. */
const ModelPricesFileSchema = z
  .record(z.string().min(1), ModelPriceSchema)
  .refine((prices) => Object.keys(prices).length > 0, {
    message: 'the prices file names no model',
  });

export type ModelPrice = z.infer<typeof ModelPriceSchema>;
type PriceRates = z.infer<typeof PriceRatesSchema>;

/** Prices by model id (`<provider/model>`). */
export type ModelPrices = ReadonlyMap<string, ModelPrice>;

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * Checks the parsed JSON of the prices file. A file without models or with a negative price throws,
 * naming the problem, which stops the start.
 */
export function parseModelPrices(json: unknown): ModelPrices {
  const result = ModelPricesFileSchema.safeParse(json);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid model prices — ${problems.join('; ')}`);
  }
  return new Map(Object.entries(result.data));
}

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
