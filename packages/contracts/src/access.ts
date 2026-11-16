import { z } from 'zod';

/** Model catalogue, grants and "My access" (design-access.md, Contract Definitions). */

const MODEL_NAME_MAX_LENGTH = 80;

/** Error codes of the access part (`errorCode` of ApiErrorSchema). */
export const AccessErrorCode = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_ID_TAKEN: 'MODEL_ID_TAKEN',
  GRANT_NOT_FOUND: 'GRANT_NOT_FOUND',
  GRANT_EXISTS: 'GRANT_EXISTS',
  GRANT_TARGET_UNKNOWN: 'GRANT_TARGET_UNKNOWN',
  GRANT_INVALID: 'GRANT_INVALID',
} as const;
export type AccessErrorCode = (typeof AccessErrorCode)[keyof typeof AccessErrorCode];

/** `reason` of a 422 GRANT_INVALID. */
export const GrantInvalidReasonSchema = z.enum([
  'deny_for_role',
  'quota_not_on_model_allow',
  'quota_out_of_range',
]);
export type GrantInvalidReason = z.infer<typeof GrantInvalidReasonSchema>;

/** `reason` of a 422 GRANT_TARGET_UNKNOWN. */
export const GrantTargetUnknownReasonSchema = z.enum([
  'server_unknown',
  'tool_unknown',
  'model_unknown',
]);
export type GrantTargetUnknownReason = z.infer<typeof GrantTargetUnknownReasonSchema>;

// ---------- Model catalogue ----------

/** Model ID `anthropic/<name>`, the form of AGENT_DEFAULT_MODEL. */
export const ModelIdSchema = z
  .string()
  .regex(/^anthropic\/[^/\s]+$/, 'expected anthropic/<model id>');

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

const catalogModelFields = {
  name: ModelNameSchema,
  prices: PriceRatesSchema,
  /** `null` — one price. */
  longContext: LongContextSchema.nullable(),
};

/** Row of GET /api/admin/models (by name). */
export const CatalogModelSchema = z.object({ id: ModelIdSchema, ...catalogModelFields });
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/** Body of POST /api/admin/models. */
export const CreateCatalogModelBodySchema = CatalogModelSchema;
export type CreateCatalogModelBody = z.infer<typeof CreateCatalogModelBodySchema>;

/** Body of PATCH /api/admin/models/:id. The id never changes. */
export const UpdateCatalogModelBodySchema = z
  .strictObject({
    name: catalogModelFields.name.optional(),
    prices: catalogModelFields.prices.optional(),
    longContext: catalogModelFields.longContext.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.prices !== undefined || body.longContext !== undefined,
    { message: 'name, prices or longContext is required' },
  );
export type UpdateCatalogModelBody = z.infer<typeof UpdateCatalogModelBodySchema>;

// ---------- Grants ----------

export const GrantEffectSchema = z.enum(['allow', 'deny']);
export type GrantEffect = z.infer<typeof GrantEffectSchema>;

export const GrantTargetKindSchema = z.enum(['server', 'tool', 'model']);
export type GrantTargetKind = z.infer<typeof GrantTargetKindSchema>;

const serverTarget = z.object({ kind: z.literal('server'), server: z.string().min(1) });
const toolTarget = z.object({
  kind: z.literal('tool'),
  server: z.string().min(1),
  tool: z.string().min(1),
});
const modelTarget = z.object({ kind: z.literal('model'), model: ModelIdSchema });

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
  .refine((body) => (body.roleId === undefined) !== (body.userId === undefined), {
    message: 'exactly one of roleId and userId is required',
  });
export type CreateGrantBody = z.infer<typeof CreateGrantBodySchema>;

/** Body of PATCH /api/admin/grants/:id; `null` removes the quota. */
export const UpdateGrantBodySchema = z.object({ quotaUsd: QuotaUsdBodySchema });
export type UpdateGrantBody = z.infer<typeof UpdateGrantBodySchema>;

// ---------- Employee: my access ----------

/** A model allowed to the employee now, with this month's spend. */
export const MyModelSchema = z.object({
  model: ModelIdSchema,
  name: z.string(),
  spentUsd: z.number(),
  /** `null` — no limit. */
  quotaUsd: z.number().nullable(),
  /** `null` — no limit; never below zero. */
  remainingUsd: z.number().nonnegative().nullable(),
  /** Spend is not below the quota. */
  exhausted: z.boolean(),
});
export type MyModel = z.infer<typeof MyModelSchema>;

/** Response of GET /api/access/models (models by name). */
export const MyModelsSchema = z.object({
  /** UTC month `YYYY-MM`, as in GET /spend. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  models: z.array(MyModelSchema),
});
export type MyModels = z.infer<typeof MyModelsSchema>;
