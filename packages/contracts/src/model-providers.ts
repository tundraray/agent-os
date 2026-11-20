import { z } from 'zod';

/** Registry of model providers (design-core.md of model-providers, Contract Definitions). */

/** Max length of a provider name: the first part of the ids of its models. */
export const MODEL_PROVIDER_NAME_MAX_LENGTH = 32;
/** Shortest key accepted: the log mask hides values from 8 characters. */
export const MODEL_PROVIDER_API_KEY_MIN_LENGTH = 8;
export const MODEL_PROVIDER_API_KEY_MAX_LENGTH = 512;
const MODEL_PROVIDER_BASE_URL_MAX_LENGTH = 2048;
const MODEL_PROVIDER_CHECK_MESSAGE_MAX_LENGTH = 500;

/** Error codes of the model provider registry (`errorCode` of ApiErrorSchema). */
export const ModelProviderErrorCode = {
  MODEL_PROVIDER_NOT_FOUND: 'MODEL_PROVIDER_NOT_FOUND',
  MODEL_PROVIDER_NAME_TAKEN: 'MODEL_PROVIDER_NAME_TAKEN',
  /** 409 on delete, with the number of catalogue models in `count`. */
  MODEL_PROVIDER_HAS_MODELS: 'MODEL_PROVIDER_HAS_MODELS',
} as const;
export type ModelProviderErrorCode =
  (typeof ModelProviderErrorCode)[keyof typeof ModelProviderErrorCode];

/** Provider name: lowercase latin letters, digits and hyphens, from a letter or digit; never changes. */
export const ModelProviderNameSchema = z
  .string()
  .max(MODEL_PROVIDER_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'expected lowercase letters, digits and hyphens');

export const ModelProviderKindSchema = z.enum(['anthropic', 'gemini', 'openai_compatible']);
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>;

/** State of a registered provider by `providerReadiness`; a disabled provider without a key is `disabled`. */
export const ModelProviderStateSchema = z.enum(['ready', 'disabled', 'key_missing']);
export type ModelProviderState = z.infer<typeof ModelProviderStateSchema>;

const BaseUrlSchema = z.url({ protocol: /^https?$/ }).max(MODEL_PROVIDER_BASE_URL_MAX_LENGTH);

const ApiKeySchema = z
  .string()
  .min(MODEL_PROVIDER_API_KEY_MIN_LENGTH)
  .max(MODEL_PROVIDER_API_KEY_MAX_LENGTH);

/** A provider as the admin sees it: no key value, only whether it is set and its last four characters. */
export const ModelProviderViewSchema = z.object({
  name: ModelProviderNameSchema,
  kind: ModelProviderKindSchema,
  /** `null` — the kind's default address. */
  baseUrl: BaseUrlSchema.nullable(),
  /** The address requests go to: the set one or the kind's default. */
  effectiveBaseUrl: BaseUrlSchema,
  enabled: z.boolean(),
  apiKeySet: z.boolean(),
  apiKeyLast4: z.string().nullable(),
  /** The kind needs a key: `true` for `anthropic` and `gemini`. */
  keyRequired: z.boolean(),
  /** The kind serves embedding models: `false` for `anthropic`. */
  servesEmbeddings: z.boolean(),
  state: ModelProviderStateSchema,
  /** Number of the provider's models in the catalogue. */
  catalogModels: z.number().int().nonnegative(),
});
export type ModelProviderView = z.infer<typeof ModelProviderViewSchema>;

/** Response of POST /api/admin/model-providers/:name/check. */
export const ModelProviderCheckSchema = z.object({
  result: z.enum(['works', 'key_rejected', 'unreachable']),
  /** Provider status and response text through the secret mask; `null` on `works`. */
  message: z.string().max(MODEL_PROVIDER_CHECK_MESSAGE_MAX_LENGTH).nullable(),
});
export type ModelProviderCheck = z.infer<typeof ModelProviderCheckSchema>;

/** Body of POST /api/admin/model-providers: the provider is created enabled. */
export const CreateModelProviderBodySchema = z.object({
  name: ModelProviderNameSchema,
  kind: ModelProviderKindSchema,
  baseUrl: BaseUrlSchema.optional(),
  apiKey: ApiKeySchema.optional(),
});
export type CreateModelProviderBody = z.infer<typeof CreateModelProviderBodySchema>;

/**
 * Body of PATCH /api/admin/model-providers/:name. Name and kind never change; `baseUrl: null` — the
 * kind's default address, `apiKey: null` — remove the key.
 */
export const UpdateModelProviderBodySchema = z
  .strictObject({
    baseUrl: BaseUrlSchema.nullable().optional(),
    apiKey: ApiKeySchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (body) => body.baseUrl !== undefined || body.apiKey !== undefined || body.enabled !== undefined,
    { message: 'baseUrl, apiKey or enabled is required' },
  );
export type UpdateModelProviderBody = z.infer<typeof UpdateModelProviderBodySchema>;
