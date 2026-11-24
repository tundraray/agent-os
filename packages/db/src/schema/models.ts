import {
  EMBEDDING_DIMENSIONS_MAX,
  EMBEDDING_DIMENSIONS_MIN,
  ModelPurposeSchema,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { check, integer, numeric, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, isWithin, literal } from './helpers';
import { modelProviders } from './model-providers';

/** Price in USD per million tokens. */
const usdPerMTok = (name: string) =>
  numeric(name, { precision: 18, scale: 9, mode: 'number' });

/** Model catalogue: a model is callable only when it is here. */
export const models = app.table(
  'models',
  {
    /** Model ID as the provider knows it. */
    id: text('id').primaryKey(),
    /** The provider of the model: the first part of its id, which the CHECK keeps equal. */
    provider: text('provider')
      .notNull()
      .references(() => modelProviders.name, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    inputUsdPerMTok: usdPerMTok('input_usd_per_mtok').notNull(),
    outputUsdPerMTok: usdPerMTok('output_usd_per_mtok').notNull(),
    cacheWriteUsdPerMTok: usdPerMTok('cache_write_usd_per_mtok').notNull(),
    cacheReadUsdPerMTok: usdPerMTok('cache_read_usd_per_mtok').notNull(),
    /** Long-context prices apply when the whole input of a call is above this; null — one price. */
    longContextAboveInputTokens: integer('long_context_above_input_tokens'),
    longContextInputUsdPerMTok: usdPerMTok('long_context_input_usd_per_mtok'),
    longContextOutputUsdPerMTok: usdPerMTok('long_context_output_usd_per_mtok'),
    longContextCacheWriteUsdPerMTok: usdPerMTok(
      'long_context_cache_write_usd_per_mtok',
    ),
    longContextCacheReadUsdPerMTok: usdPerMTok(
      'long_context_cache_read_usd_per_mtok',
    ),
    /** Never changes after the model is added. */
    purpose: text('purpose').notNull().default(ModelPurposeSchema.enum.chat),
    /** Vector length of an embedding model; null for a chat model. */
    dimensions: integer('dimensions'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'models_provider_check',
      sql`${t.provider} = split_part(${t.id}, '/', 1)`,
    ),
    /** Null long-context prices pass: `null >= 0` is not false. */
    check(
      'models_prices_check',
      sql`${t.inputUsdPerMTok} >= 0 and ${t.outputUsdPerMTok} >= 0
        and ${t.cacheWriteUsdPerMTok} >= 0 and ${t.cacheReadUsdPerMTok} >= 0
        and ${t.longContextInputUsdPerMTok} >= 0 and ${t.longContextOutputUsdPerMTok} >= 0
        and ${t.longContextCacheWriteUsdPerMTok} >= 0 and ${t.longContextCacheReadUsdPerMTok} >= 0`,
    ),
    check(
      'models_long_context_threshold_check',
      sql`${t.longContextAboveInputTokens} > 0`,
    ),
    /** All five long-context columns are set or none; `or` keeps the CHECK out of `= ANY`. */
    check(
      'models_long_context_check',
      sql`num_nulls(${t.longContextAboveInputTokens}, ${t.longContextInputUsdPerMTok},
          ${t.longContextOutputUsdPerMTok}, ${t.longContextCacheWriteUsdPerMTok},
          ${t.longContextCacheReadUsdPerMTok}) = 0
        or num_nulls(${t.longContextAboveInputTokens}, ${t.longContextInputUsdPerMTok},
          ${t.longContextOutputUsdPerMTok}, ${t.longContextCacheWriteUsdPerMTok},
          ${t.longContextCacheReadUsdPerMTok}) = 5`,
    ),
    check(
      'models_purpose_check',
      isOneOf(t.purpose, ModelPurposeSchema.options),
    ),
    /**
     * An embedding model has dimensions and no long-context prices; a chat model has no dimensions.
     * `is not null` keeps a null from passing: `null between …` is not false.
     */
    check(
      'models_dimensions_check',
      sql`(${t.purpose} = ${literal(ModelPurposeSchema.enum.embedding)}
          and ${t.dimensions} is not null
          and ${isWithin(t.dimensions, EMBEDDING_DIMENSIONS_MIN, EMBEDDING_DIMENSIONS_MAX)}
          and ${t.longContextAboveInputTokens} is null)
        or (${t.purpose} = ${literal(ModelPurposeSchema.enum.chat)} and ${t.dimensions} is null)`,
    ),
  ],
);
