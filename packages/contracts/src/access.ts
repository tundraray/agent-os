import { z } from 'zod';

import { ModelProviderNameSchema } from './model-providers';
import { ApiErrorSchema } from './threads';

/**
 * Model catalogue, model defaults, grants and "My access" (design-access.md and design-core.md of
 * model-providers, Contract Definitions).
 */

const MODEL_NAME_MAX_LENGTH = 80;
export const EMBEDDING_DIMENSIONS_MIN = 1;
export const EMBEDDING_DIMENSIONS_MAX = 4096;

/** Error codes of the access part (`errorCode` of ApiErrorSchema). */
export const AccessErrorCode = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_ID_TAKEN: 'MODEL_ID_TAKEN',
  MODEL_PROVIDER_INVALID: 'MODEL_PROVIDER_INVALID',
  MODEL_DEFAULT_INVALID: 'MODEL_DEFAULT_INVALID',
  GRANT_NOT_FOUND: 'GRANT_NOT_FOUND',
  GRANT_EXISTS: 'GRANT_EXISTS',
  GRANT_TARGET_UNKNOWN: 'GRANT_TARGET_UNKNOWN',
  GRANT_INVALID: 'GRANT_INVALID',
} as const;
export type AccessErrorCode =
  (typeof AccessErrorCode)[keyof typeof AccessErrorCode];

/** `reason` of a 422 GRANT_INVALID. */
export const GrantInvalidReasonSchema = z.enum([
  'deny_for_role',
  'quota_not_on_model_allow',
  'quota_out_of_range',
  'embedding_model',
]);
export type GrantInvalidReason = z.infer<typeof GrantInvalidReasonSchema>;

/** `reason` of a 422 MODEL_PROVIDER_INVALID on adding a catalogue model. */
export const ModelProviderInvalidReasonSchema = z.enum([
  'provider_unknown',
  'embeddings_not_supported',
]);
export type ModelProviderInvalidReason = z.infer<
  typeof ModelProviderInvalidReasonSchema
>;

/** `reason` of a 422 MODEL_DEFAULT_INVALID. */
export const ModelDefaultInvalidReasonSchema = z.enum([
  'model_unknown',
  'not_chat',
  'not_embedding',
]);
export type ModelDefaultInvalidReason = z.infer<
  typeof ModelDefaultInvalidReasonSchema
>;

/** 422 MODEL_DEFAULT_INVALID of PUT /api/admin/model-defaults; `model` is the rejected id. */
export const ModelDefaultInvalidErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal(AccessErrorCode.MODEL_DEFAULT_INVALID),
  reason: ModelDefaultInvalidReasonSchema,
  model: z.string().min(1),
});
export type ModelDefaultInvalidError = z.infer<
  typeof ModelDefaultInvalidErrorSchema
>;

/** `reason` of a 422 GRANT_TARGET_UNKNOWN. */
export const GrantTargetUnknownReasonSchema = z.enum([
  'server_unknown',
  'tool_unknown',
  'model_unknown',
]);
export type GrantTargetUnknownReason = z.infer<
  typeof GrantTargetUnknownReasonSchema
>;

// ---------- Model catalogue ----------

/**
 * Model ID `<provider>/<name at the provider>`, split at the first slash (ADR-0018). The name is
 * non-empty, has no whitespace and may hold slashes, as `local/Qwen/Qwen3-32B`.
 */
export const ModelIdSchema = z.string().refine((id) => {
  const slash = id.indexOf('/');
  return (
    slash > 0 &&
    ModelProviderNameSchema.safeParse(id.slice(0, slash)).success &&
    /^\S+$/.test(id.slice(slash + 1))
  );
}, 'expected <provider>/<model name>');

/** Provider of a valid model id: its part before the first slash. */
export function modelProvider(modelId: string): string {
  return modelId.slice(0, modelId.indexOf('/'));
}

export const ModelPurposeSchema = z.enum(['chat', 'embedding']);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

const ModelNameSchema = z.string().min(1).max(MODEL_NAME_MAX_LENGTH);

const UsdPerMTokSchema = z.number().nonnegative();

/** Dollars per million tokens. */
export const PriceRatesSchema = z.object({
  inputUsdPerMTok: UsdPerMTokSchema,
  outputUsdPerMTok: UsdPerMTokSchema,
  cacheWriteUsdPerMTok: UsdPerMTokSchema,
  cacheReadUsdPerMTok: UsdPerMTokSchema,
});
export type PriceRates = z.infer<typeof PriceRatesSchema>;

/** Prices that apply when the whole input of a call is above the threshold. */
export const LongContextSchema = z.object({
  aboveInputTokens: z.number().int().positive(),
  prices: PriceRatesSchema,
});
export type LongContext = z.infer<typeof LongContextSchema>;

/** `null` — one price. */
const LongContextFieldSchema = LongContextSchema.nullable();

/** Vector length of an embedding model; never changes. */
const DimensionsSchema = z
  .number()
  .int()
  .min(EMBEDDING_DIMENSIONS_MIN)
  .max(EMBEDDING_DIMENSIONS_MAX);

const chatModelFields = {
  id: ModelIdSchema,
  name: ModelNameSchema,
  purpose: z.literal(ModelPurposeSchema.enum.chat),
  prices: PriceRatesSchema,
  longContext: LongContextFieldSchema,
};

const embeddingModelFields = {
  id: ModelIdSchema,
  name: ModelNameSchema,
  purpose: z.literal(ModelPurposeSchema.enum.embedding),
  inputUsdPerMTok: UsdPerMTokSchema,
  dimensions: DimensionsSchema,
};

/** Body of POST /api/admin/models: the whole id, and the fields of the model's purpose. */
export const CreateCatalogModelBodySchema = z.discriminatedUnion('purpose', [
  z.object(chatModelFields),
  z.object(embeddingModelFields),
]);
export type CreateCatalogModelBody = z.infer<
  typeof CreateCatalogModelBodySchema
>;

/** Row of GET /api/admin/models (by name); `provider` is the first part of the id. */
export const CatalogModelSchema = z.discriminatedUnion('purpose', [
  z.object({ ...chatModelFields, provider: ModelProviderNameSchema }),
  z.object({ ...embeddingModelFields, provider: ModelProviderNameSchema }),
]);
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/**
 * Body of PATCH /api/admin/models/:id. The id and the purpose never change; a field of the other
 * purpose is rejected by the service, which reads the row's purpose.
 */
export const UpdateCatalogModelBodySchema = z
  .strictObject({
    name: ModelNameSchema.optional(),
    prices: PriceRatesSchema.optional(),
    longContext: LongContextFieldSchema.optional(),
    inputUsdPerMTok: UsdPerMTokSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.prices !== undefined ||
      body.longContext !== undefined ||
      body.inputUsdPerMTok !== undefined,
    { message: 'name, prices, longContext or inputUsdPerMTok is required' },
  );
export type UpdateCatalogModelBody = z.infer<
  typeof UpdateCatalogModelBodySchema
>;

// ---------- Model defaults ----------

/** Response of GET/PUT /api/admin/model-defaults; `updatedAt` and `updatedBy` are `null` until first set. */
export const ModelDefaultsSchema = z.object({
  /** `null` — not chosen. */
  chatModel: ModelIdSchema.nullable(),
  /** `null` — not chosen. */
  embeddingModel: ModelIdSchema.nullable(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.uuid().nullable(),
});
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

/** Body of PUT /api/admin/model-defaults: each a catalogue model id of its purpose, or `null`. */
export const UpdateModelDefaultsBodySchema = z.object({
  chatModel: ModelIdSchema.nullable(),
  embeddingModel: ModelIdSchema.nullable(),
});
export type UpdateModelDefaultsBody = z.infer<
  typeof UpdateModelDefaultsBodySchema
>;

// ---------- Grants ----------

export const GrantEffectSchema = z.enum(['allow', 'deny']);
export type GrantEffect = z.infer<typeof GrantEffectSchema>;

export const GrantTargetKindSchema = z.enum(['server', 'tool', 'model']);
export type GrantTargetKind = z.infer<typeof GrantTargetKindSchema>;

const serverTarget = z.object({
  kind: z.literal('server'),
  server: z.string().min(1),
});
const toolTarget = z.object({
  kind: z.literal('tool'),
  server: z.string().min(1),
  tool: z.string().min(1),
});
const modelTarget = z.object({
  kind: z.literal('model'),
  model: ModelIdSchema,
});

/** Target of a grant as the admin sends it. Server and tool names are text, as in the registry. */
export const GrantTargetBodySchema = z.discriminatedUnion('kind', [
  serverTarget,
  toolTarget,
  modelTarget,
]);
export type GrantTargetBody = z.infer<typeof GrantTargetBodySchema>;

/** Target of a grant in a response: a model target carries the catalogue name. */
export const GrantTargetSchema = z.discriminatedUnion('kind', [
  serverTarget,
  toolTarget,
  modelTarget.extend({ modelName: z.string() }),
]);
export type GrantTarget = z.infer<typeof GrantTargetSchema>;

export const GrantHolderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), id: z.uuid(), name: z.string() }),
  z.object({ kind: z.literal('user'), id: z.uuid() }),
]);
export type GrantHolder = z.infer<typeof GrantHolderSchema>;

/** Row of GET /api/admin/grants (by creation time). */
export const GrantSchema = z.object({
  id: z.uuid(),
  holder: GrantHolderSchema,
  effect: GrantEffectSchema,
  target: GrantTargetSchema,
  /** Only on a model allow; `null` — no quota. */
  quotaUsd: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
export type Grant = z.infer<typeof GrantSchema>;

/**
 * Quota of a grant body. No bounds here: a deny for a role, a quota not on a model allow and a
 * quota out of range are 422 GRANT_INVALID with a `reason` from the service, not the pipe's 400.
 */
const QuotaUsdBodySchema = z.number().nullable();

/** Body of POST /api/admin/grants: exactly one of `roleId` and `userId`. */
export const CreateGrantBodySchema = z
  .object({
    roleId: z.uuid().optional(),
    userId: z.uuid().optional(),
    effect: GrantEffectSchema,
    target: GrantTargetBodySchema,
    quotaUsd: QuotaUsdBodySchema.optional(),
  })
  .refine(
    (body) => (body.roleId === undefined) !== (body.userId === undefined),
    {
      message: 'exactly one of roleId and userId is required',
    },
  );
export type CreateGrantBody = z.infer<typeof CreateGrantBodySchema>;

/** Body of PATCH /api/admin/grants/:id; `null` removes the quota. */
export const UpdateGrantBodySchema = z.object({ quotaUsd: QuotaUsdBodySchema });
export type UpdateGrantBody = z.infer<typeof UpdateGrantBodySchema>;

// ---------- Employee: my access ----------

/** Why a chat model's provider is not ready (`unavailableReason` of "My access"). */
export const ModelUnavailableReasonSchema = z.enum([
  'provider_missing',
  'provider_disabled',
  'provider_key_missing',
]);
export type ModelUnavailableReason = z.infer<
  typeof ModelUnavailableReasonSchema
>;

/** A chat model allowed to the employee now, with this month's spend. */
export const MyModelSchema = z.object({
  model: ModelIdSchema,
  name: z.string(),
  /** `null` — the provider is ready. */
  unavailableReason: ModelUnavailableReasonSchema.nullable(),
  spentUsd: z.number(),
  /** `null` — no limit. */
  quotaUsd: z.number().nullable(),
  /** `null` — no limit; never below zero. */
  remainingUsd: z.number().nonnegative().nullable(),
  /** Spend is not below the quota. */
  exhausted: z.boolean(),
});
export type MyModel = z.infer<typeof MyModelSchema>;

/** Response of GET /api/access/models (chat models by name). */
export const MyModelsSchema = z.object({
  /** UTC month `YYYY-MM`, as in GET /spend. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  models: z.array(MyModelSchema),
});
export type MyModels = z.infer<typeof MyModelsSchema>;
