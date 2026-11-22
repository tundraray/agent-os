import { z } from 'zod';
import { ModelIdSchema } from './access';
import { McpServerNameSchema } from './mcp';

/**
 * Knowledge graph of a self-learning deep agent (self-learning design-core.md, Contract Definitions,
 * «Для части `web`»). No view carries the run or the employee a record came from (DC-2, AC-11.4).
 */

/** Bounds and default of the knowledge limit in tokens (`agent_knowledge_settings.limit_tokens`). */
export const KNOWLEDGE_LIMIT_TOKENS_MIN = 1_000;
export const KNOWLEDGE_LIMIT_TOKENS_MAX = 32_000;
export const KNOWLEDGE_LIMIT_TOKENS_DEFAULT = 8_000;

export const KnowledgeItemTypeSchema = z.enum(['entity', 'relation']);
export type KnowledgeItemType = z.infer<typeof KnowledgeItemTypeSchema>;

/** An entity is always a `fact`. */
export const KnowledgeItemKindSchema = z.enum(['fact', 'lesson', 'searched_nothing']);
export type KnowledgeItemKind = z.infer<typeof KnowledgeItemKindSchema>;

/**
 * `outdated` — marked by the model or its tool is gone from the deep agent; `lessons_off` — a lesson
 * while lessons are off. An outdated lesson stays `outdated` whatever the lessons setting.
 */
export const KnowledgeItemStateSchema = z.enum(['active', 'outdated', 'lessons_off']);
export type KnowledgeItemState = z.infer<typeof KnowledgeItemStateSchema>;

/** Whether an `active` record reaches runs; `null` off `active`, without self-learning or when all fit. */
export const KnowledgePlacementSchema = z.enum(['always', 'by_topic', 'does_not_fit']).nullable();
export type KnowledgePlacement = z.infer<typeof KnowledgePlacementSchema>;

export const LastExtractionStatusSchema = z.enum(['done', 'skipped', 'failed']);
export type LastExtractionStatus = z.infer<typeof LastExtractionStatusSchema>;

/** Reasons of `skipped` (the first six) and of `failed` (the last three). */
export const LastExtractionReasonSchema = z.enum([
  'stopped',
  'owner_disabled',
  'quota_exhausted',
  'model_not_connected',
  'model_not_allowed',
  'no_models_allowed',
  'model_error',
  'invalid_answer',
  'interrupted',
]);
export type LastExtractionReason = z.infer<typeof LastExtractionReasonSchema>;

/** Why an embeddings call gave no vectors (self-learning/design-core.md, Contract `Agents.embeddings.embed`). */
export const EmbeddingFailureReasonSchema = z.enum([
  'model_not_configured',
  'owner_disabled',
  'provider_missing',
  'provider_disabled',
  'provider_key_missing',
  'provider_key_rejected',
  'provider_unavailable',
  'provider_error',
  'dimension_mismatch',
]);
export type EmbeddingFailureReason = z.infer<typeof EmbeddingFailureReasonSchema>;

/** State of selection by meaning: the first state that applies, top to bottom. */
export const KnowledgeSelectionSchema = z.discriminatedUnion('state', [
  z.discriminatedUnion('reason', [
    z.object({ state: z.literal('off'), reason: z.literal('model_not_selected'), model: z.null() }),
    z.object({ state: z.literal('off'), reason: z.literal('provider_failed'), model: ModelIdSchema }),
  ]),
  /** `pending` — `active` records without a vector of the current model. */
  z.object({ state: z.literal('preparing'), pending: z.number().int().positive() }),
  z.object({ state: z.literal('on') }),
]);
export type KnowledgeSelection = z.infer<typeof KnowledgeSelectionSchema>;

const ItemIdSchema = z.number().int().positive();

/** Fields every record has; `date` — commit of the round that added it or last confirmed it. */
const itemFields = {
  /** Unique within its `type`. */
  id: ItemIdSchema,
  confirmations: z.number().int().min(1),
  date: z.iso.datetime(),
  state: KnowledgeItemStateSchema,
  placement: KnowledgePlacementSchema,
};

const relationFields = { ...itemFields, type: z.literal(KnowledgeItemTypeSchema.enum.relation) };

const toolFields = { server: McpServerNameSchema, tool: z.string(), question: z.string() };

const EntityEndSchema = z.object({ id: ItemIdSchema, name: z.string() });

export const KnowledgeItemSchema = z.discriminatedUnion('type', [
  z.object({
    ...itemFields,
    type: z.literal(KnowledgeItemTypeSchema.enum.entity),
    kind: z.literal(KnowledgeItemKindSchema.enum.fact),
    name: z.string(),
    description: z.string(),
  }),
  z.discriminatedUnion('kind', [
    z.object({
      ...relationFields,
      kind: z.literal(KnowledgeItemKindSchema.enum.fact),
      from: EntityEndSchema,
      to: EntityEndSchema,
      label: z.string(),
    }),
    z.object({
      ...relationFields,
      ...toolFields,
      kind: z.literal(KnowledgeItemKindSchema.enum.lesson),
      hint: z.string(),
      outcome: z.string(),
    }),
    z.object({
      ...relationFields,
      ...toolFields,
      kind: z.literal(KnowledgeItemKindSchema.enum.searched_nothing),
    }),
  ]),
]);
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

/** Last round of any run of the deep agent; numbers count operations of a `done` round. */
export const LastExtractionSchema = z.object({
  at: z.iso.datetime(),
  model: ModelIdSchema,
  status: LastExtractionStatusSchema,
  added: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  outdated: z.number().int().nonnegative(),
  /** `null` on `done`. */
  reason: LastExtractionReasonSchema.nullable(),
});
export type LastExtraction = z.infer<typeof LastExtractionSchema>;

/** Numbers of the screen's state lines (UXRD MC-3). */
export const KnowledgeCountsSchema = z.object({
  active: z.number().int().nonnegative(),
  always: z.number().int().nonnegative(),
  beyond: z.number().int().nonnegative(),
  outdated: z.number().int().nonnegative(),
  /** Size of all `active` records in percent of the limit; above 100 when they exceed it. */
  percent: z.number().int().nonnegative(),
});
export type KnowledgeCounts = z.infer<typeof KnowledgeCountsSchema>;

/** Response of GET /api/library/:id/knowledge. */
export const KnowledgeViewSchema = z.object({
  selfLearning: z.boolean(),
  lessonsEnabled: z.boolean(),
  selection: KnowledgeSelectionSchema,
  counts: KnowledgeCountsSchema,
  /** Common order, `outdated` records last. */
  items: z.array(KnowledgeItemSchema),
  lastExtraction: LastExtractionSchema.nullable(),
});
export type KnowledgeView = z.infer<typeof KnowledgeViewSchema>;

const knowledgeSettingsFields = {
  limitTokens: z
    .number()
    .int()
    .min(KNOWLEDGE_LIMIT_TOKENS_MIN)
    .max(KNOWLEDGE_LIMIT_TOKENS_MAX),
  lessonsEnabled: z.boolean(),
};

/** Body of PUT /api/admin/knowledge/settings. */
export const UpdateKnowledgeSettingsBodySchema = z.strictObject(knowledgeSettingsFields);
export type UpdateKnowledgeSettingsBody = z.infer<typeof UpdateKnowledgeSettingsBodySchema>;

/** Response of GET/PUT /api/admin/knowledge/settings. `updatedAt: null` while the defaults stand. */
export const KnowledgeSettingsSchema = z.object({
  ...knowledgeSettingsFields,
  updatedAt: z.iso.datetime().nullable(),
});
export type KnowledgeSettings = z.infer<typeof KnowledgeSettingsSchema>;
