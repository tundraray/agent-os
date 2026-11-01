/** Prices in USD per million tokens for requests up to `upToInputTokens` input tokens (null — no upper bound). */
export interface ModelPriceTier {
  readonly upToInputTokens: number | null;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** 5-minute cache write. */
  readonly cacheWriteUsdPerMTok: number;
  readonly cacheReadUsdPerMTok: number;
}

export interface ModelCatalogEntry {
  readonly contextWindowTokens: number;
  /** Ordered by `upToInputTokens`, the unbounded tier last. */
  readonly tiers: readonly ModelPriceTier[];
}

/** `provider/model` → window and prices. The assembly point may pass its own catalog to `createEngine`. */
export type ModelCatalog = Readonly<Record<string, ModelCatalogEntry>>;

/** The provider's pricing page as of 2026-11-01 (design-engine.md, Runtime settings). */
export const DEFAULT_MODEL_CATALOG: ModelCatalog = {
  'anthropic/claude-haiku-5-5': {
    contextWindowTokens: 1_000_000,
    tiers: [
      {
        upToInputTokens: 100_000,
        inputUsdPerMTok: 0.1,
        outputUsdPerMTok: 0.5,
        cacheWriteUsdPerMTok: 0.125,
        cacheReadUsdPerMTok: 0.01,
      },
      {
        upToInputTokens: null,
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2.5,
        cacheWriteUsdPerMTok: 0.625,
        cacheReadUsdPerMTok: 0.05,
      },
    ],
  },
  'anthropic/claude-sonnet-5-5': {
    contextWindowTokens: 1_000_000,
    tiers: [
      {
        upToInputTokens: null,
        inputUsdPerMTok: 2,
        outputUsdPerMTok: 10,
        cacheWriteUsdPerMTok: 2.5,
        cacheReadUsdPerMTok: 0.1,
      },
    ],
  },
};
