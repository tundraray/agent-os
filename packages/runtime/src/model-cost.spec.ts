import { callCostUsd, type CallUsage, parseModelPrices } from './model-cost.js';

const FLAT = 'test/flat';
const TIERED = 'test/tiered';

const rates = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  cacheWriteUsdPerMTok: 3.75,
  cacheReadUsdPerMTok: 0.3,
};

const PRICES = parseModelPrices({
  [FLAT]: rates,
  [TIERED]: {
    ...rates,
    above: {
      inputTokens: 200_000,
      inputUsdPerMTok: 6,
      outputUsdPerMTok: 22.5,
      cacheWriteUsdPerMTok: 7.5,
      cacheReadUsdPerMTok: 0.6,
    },
  },
});

const usage = (overrides: Partial<CallUsage>): CallUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
});

// AC-02.2 (rule), KD-5. Catches: tier boundary taken with `>=`, uncached input counted twice
// (cache parts not subtracted), wrong divisor.
describe("cost of a call follows the model's price", () => {
  it.each([
    {
      name: 'a model without a tier: input and output at their rates',
      model: FLAT,
      call: usage({ inputTokens: 1000, outputTokens: 500 }),
      // 1000 * 3 + 500 * 15 = 10500 micro-USD
      costUsd: 0.0105,
    },
    {
      name: 'input equal to the tier threshold keeps the base price',
      model: TIERED,
      call: usage({ inputTokens: 200_000, outputTokens: 1000 }),
      // 200000 * 3 + 1000 * 15 = 615000 micro-USD
      costUsd: 0.615,
    },
    {
      name: 'input above the tier threshold takes the tier price',
      model: TIERED,
      call: usage({ inputTokens: 200_001, outputTokens: 1000 }),
      // 200001 * 6 + 1000 * 22.5 = 1222506 micro-USD
      costUsd: 1.222506,
    },
    {
      name: 'cache read and write are priced apart from the uncached input',
      model: FLAT,
      call: usage({
        inputTokens: 10_000,
        cacheReadTokens: 6000,
        cacheWriteTokens: 2000,
        outputTokens: 100,
      }),
      // uncached 2000 * 3 + write 2000 * 3.75 + read 6000 * 0.3 + output 100 * 15 = 16800 micro-USD
      costUsd: 0.0168,
    },
  ])('$name', ({ model, call, costUsd }) => {
    const price = PRICES.get(model);
    if (price === undefined) throw new Error(`no price for ${model}`);
    expect(callCostUsd(price, call)).toBeCloseTo(costUsd, 12);
  });

  it.each([
    { name: 'a file without models', json: {}, error: /names no model/ },
    {
      name: 'a negative price',
      json: { [FLAT]: { ...rates, outputUsdPerMTok: -1 } },
      error: /outputUsdPerMTok/,
    },
  ])('parseModelPrices rejects $name', ({ json, error }) => {
    expect(() => parseModelPrices(json)).toThrow(error);
  });
});
