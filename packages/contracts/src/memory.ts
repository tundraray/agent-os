import { z } from 'zod';

/** Model tools of a run with memory (self-learning design-memory.md KD-2). */
export const MEMORY_TOOLS = ['remember', 'read_memory', 'forget'] as const;

/** What a version of a memory record did to it (memory-hygiene KD-1); only `deleted` has no text. */
export const MemoryVersionKindSchema = z.enum([
  'created',
  'changed',
  'deleted',
  'reverted',
]);
export type MemoryVersionKind = z.infer<typeof MemoryVersionKindSchema>;

/** A version number of a memory record: from 1 without gaps, within the int4 column. */
export const MemoryVersionNumberSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647);

/**
 * A memory record as the memory screens show it. `text` of a deleted record is the text of its last version
 * with text; `updatedAt` is the time of the current version, a deletion included.
 */
export const MemoryRecordViewSchema = z.object({
  id: z.uuid(),
  description: z.string(),
  text: z.string(),
  /** Deleted by the agent; comes back from its history. */
  deleted: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type MemoryRecordView = z.infer<typeof MemoryRecordViewSchema>;

/** A version of a memory record in its history. */
export const MemoryVersionViewSchema = z.object({
  version: MemoryVersionNumberSchema,
  kind: MemoryVersionKindSchema,
  /** `null` for `deleted`. */
  text: z.string().nullable(),
  changedAt: z.iso.datetime(),
  /** `null` — the agent made it; otherwise the person's name, or their email without a name (KD-6). */
  changedBy: z.string().nullable(),
});
export type MemoryVersionView = z.infer<typeof MemoryVersionViewSchema>;

/** Response of the history and revert routes of a memory record: its versions, newest (current) first. */
export const MemoryHistoryViewSchema = z.object({
  description: z.string(),
  versions: z.array(MemoryVersionViewSchema),
});
export type MemoryHistoryView = z.infer<typeof MemoryHistoryViewSchema>;

/** Body of POST .../memory/:memoryId/revert (KD-7). */
export const RevertMemoryBodySchema = z.strictObject({
  /** The version whose text comes back. */
  version: MemoryVersionNumberSchema,
  /** The current version the person saw on top of the history. */
  expectedVersion: MemoryVersionNumberSchema,
});
export type RevertMemoryBody = z.infer<typeof RevertMemoryBodySchema>;

/** Response of GET /api/library/:id/memory: the agent's records, most recently changed first. */
export const AgentMemoryViewSchema = z.object({
  selfLearning: z.boolean(),
  records: z.array(MemoryRecordViewSchema),
});
export type AgentMemoryView = z.infer<typeof AgentMemoryViewSchema>;

/** Response of GET /api/memory: the signed-in employee's records, most recently changed first. */
export const MyMemoryViewSchema = z.object({
  records: z.array(MemoryRecordViewSchema),
});
export type MyMemoryView = z.infer<typeof MyMemoryViewSchema>;

/** Estimated tokens of the memory index in the step prompt (KD-6). */
export const MEMORY_INDEX_TOKENS_MIN = 200;
export const MEMORY_INDEX_TOKENS_MAX = 20_000;
export const MEMORY_INDEX_TOKENS_DEFAULT = 2_000;

/** Cap of one training's spend in dollars, taken at its start (design-training.md, Runtime settings). */
export const TRAINING_CAP_USD_MIN = 0.1;
export const TRAINING_CAP_USD_MAX = 100;
export const TRAINING_CAP_USD_DEFAULT = 2;

const selfLearningSettingsFields = {
  memoryIndexTokens: z
    .number()
    .int()
    .min(MEMORY_INDEX_TOKENS_MIN)
    .max(MEMORY_INDEX_TOKENS_MAX),
  trainingCapUsd: z
    .number()
    .min(TRAINING_CAP_USD_MIN)
    .max(TRAINING_CAP_USD_MAX),
};

/** Body of PUT /api/admin/self-learning/settings: the key `self_learning_settings` of `settings`. */
export const UpdateSelfLearningSettingsBodySchema = z.strictObject(
  selfLearningSettingsFields,
);
export type UpdateSelfLearningSettingsBody = z.infer<
  typeof UpdateSelfLearningSettingsBodySchema
>;

/** Response of GET/PUT /api/admin/self-learning/settings. `updatedAt: null` while the defaults stand. */
export const SelfLearningSettingsSchema = z.object({
  ...selfLearningSettingsFields,
  updatedAt: z.iso.datetime().nullable(),
});
export type SelfLearningSettings = z.infer<typeof SelfLearningSettingsSchema>;
