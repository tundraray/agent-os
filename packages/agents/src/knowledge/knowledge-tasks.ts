import { PLATFORM_OWNER_ID, type Runtime } from '@agent-os/runtime';
import { z } from 'zod';

/*
 * The two task types of self-learning (design-core.md, Contract «Внутри платформы»): their names and
 * inputs, in one place for the handlers, the trigger and `Agents.knowledge`.
 */

export const KNOWLEDGE_EXTRACT_TASK_TYPE = 'knowledge.extract';
export const KNOWLEDGE_EMBED_TASK_TYPE = 'knowledge.embed';

/** Input of `knowledge.extract`: the coordinator task of the run and the root of its conversation. */
export const KnowledgeExtractInputSchema = z.object({ runId: z.uuid(), rootId: z.uuid() });
export type KnowledgeExtractInput = z.infer<typeof KnowledgeExtractInputSchema>;

/** Input of `knowledge.embed`: the workflow record whose graph gets vectors. */
export const KnowledgeEmbedInputSchema = z.object({ recordId: z.uuid() });
export type KnowledgeEmbedInput = z.infer<typeof KnowledgeEmbedInputSchema>;

/**
 * The request of a vector pass of the workflow. The pass belongs to the platform; who pays is the
 * vector row's `payer_id`, decided per embed call (KD-8).
 */
export function embedPassRequest(recordId: string): Parameters<Runtime['tasks']['create']>[0] {
  const input: KnowledgeEmbedInput = { recordId };
  return { type: KNOWLEDGE_EMBED_TASK_TYPE, ownerId: PLATFORM_OWNER_ID, input };
}

/** SQLSTATE foreign_key_violation: the workflow record was deleted meanwhile (DC-8). */
const FOREIGN_KEY_VIOLATION = '23503';

/** Whether the error, or a cause of it (drizzle wraps the driver's error), is a foreign key violation. */
export function isForeignKeyViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return true;
  }
  return false;
}
