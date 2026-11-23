import type {
  AgentKnowledgeRunsRepository,
  Db,
  KnowledgeEmbeddingRow,
} from '@agent-os/db';
import type { TaskControl } from '@agent-os/runtime';
import { z } from 'zod';

/*
 * The two task types of self-learning (design-core.md, Contract «Внутри платформы»): their names and
 * inputs, in one place for the handlers, the trigger and `Agents.knowledge`.
 */

export const KNOWLEDGE_EXTRACT_TASK_TYPE = 'knowledge.extract';
export const KNOWLEDGE_EMBED_TASK_TYPE = 'knowledge.embed';

/** Input of `knowledge.extract`: the deep agent task of the run and the root of its conversation. */
export const KnowledgeExtractInputSchema = z.object({
  runId: z.uuid(),
  rootId: z.uuid(),
});
export type KnowledgeExtractInput = z.infer<typeof KnowledgeExtractInputSchema>;

/** Input of `knowledge.embed`: the deep agent record whose graph gets vectors. */
export const KnowledgeEmbedInputSchema = z.object({ recordId: z.uuid() });
export type KnowledgeEmbedInput = z.infer<typeof KnowledgeEmbedInputSchema>;

/**
 * The request of a vector pass of the deep agent. The pass belongs to the platform, so its task has no owner
 * (data-model design-schema.md KD-4); who pays is the vector row's `payer_id`, decided per embed call (KD-8).
 */
export function embedPassRequest(
  recordId: string,
): Parameters<TaskControl['create']>[0] {
  const input: KnowledgeEmbedInput = { recordId };
  return { type: KNOWLEDGE_EMBED_TASK_TYPE, ownerId: null, input };
}

/** SQLSTATE foreign_key_violation: the deep agent record was deleted meanwhile (DC-8). */
const FOREIGN_KEY_VIOLATION = '23503';

/** Whether the error, or a cause of it (drizzle wraps the driver's error), is a foreign key violation. */
export function isForeignKeyViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === FOREIGN_KEY_VIOLATION)
      return true;
  }
  return false;
}

/**
 * The deep agent's vector row, written first in a transaction that goes on to change the deep agent's
 * graph or the row itself: the other such transactions of the deep agent wait until this one ends
 * (Invariant 5). In a savepoint: when the deep agent record was deleted meanwhile, the foreign key
 * fails only the savepoint and the answer is `undefined`.
 */
export async function holdKnowledgeOf(
  db: Db,
  runRows: AgentKnowledgeRunsRepository,
  recordId: string,
): Promise<KnowledgeEmbeddingRow | undefined> {
  try {
    return await db.savepoint(() => runRows.ensureEmbeddingRow(recordId));
  } catch (error) {
    if (isForeignKeyViolation(error)) return undefined;
    throw error;
  }
}
