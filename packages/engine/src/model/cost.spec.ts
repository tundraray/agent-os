import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import { type CallUsage, callCostUsd } from './cost.js';

// AC-11.1 (price half): a call is priced by the catalog tier of its whole input and by the usage
// fields of C3 — uncached input, cache write, cache read and output each at their own rate.
// Defect caught: one rate for every request (the Haiku 5.5 tier above 100 000 input tokens).
// AC-21.1 (price half, UC-8): the rows with cache reads price them below plain input; defect caught: cache reads
// priced as plain input.
const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): CallUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

describe('callCostUsd', () => {
  it.each([
    ['Haiku 5.5, small request', 'anthropic/claude-haiku-5-5', usage(1_000, 500), 0.00035],
    ['Haiku 5.5, exactly 100 000 input — lower tier', 'anthropic/claude-haiku-5-5', usage(100_000, 1_000), 0.0105],
    ['Haiku 5.5, 100 001 input — upper tier', 'anthropic/claude-haiku-5-5', usage(100_001, 1_000), 0.0525005],
    ['Haiku 5.5, upper tier with cache read and write', 'anthropic/claude-haiku-5-5', usage(200_000, 2_000, 150_000, 10_000), 0.03875],
    ['Haiku 5.5, lower tier with cache read and write', 'anthropic/claude-haiku-5-5', usage(10_000, 1_000, 6_000, 2_000), 0.00101],
    ['Sonnet 5.5 with cache read and write', 'anthropic/claude-sonnet-5-5', usage(10_000, 1_000, 6_000, 2_000), 0.0196],
    ['Sonnet 5.5, thinking inside output', 'anthropic/claude-sonnet-5-5', usage(2_675, 858), 0.01393],
  ])('%s', (_case, model, callUsage, expectedUsd) => {
    const entry = DEFAULT_MODEL_CATALOG[model];
    if (entry === undefined) throw new Error(`${model} is not in the catalog`);

    expect(callCostUsd(entry, callUsage)).toBeCloseTo(expectedUsd, 10);
  });
});
