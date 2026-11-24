import { z } from 'zod';

/** Model tools of a run with memory (self-learning design-memory.md KD-2). */
export const MEMORY_TOOLS = ['remember', 'read_memory', 'forget'] as const;

/** A memory record as the memory screens show it. */
export const MemoryRecordViewSchema = z.object({
  id: z.uuid(),
  description: z.string(),
  text: z.string(),
  updatedAt: z.iso.datetime(),
});
export type MemoryRecordView = z.infer<typeof MemoryRecordViewSchema>;

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
