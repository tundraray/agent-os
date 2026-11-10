import { ResearchAnswerBodySchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import { z } from 'zod';
import { engineRunsRepository as runs } from '../runs/engine-runs.repository.js';
import type { AnswerMessage } from './research-answer.builder.js';

/** The message stored with every answer (design-engine.md, Data Model «Ответ движка»): written with the answer, in one row. */
const StoredAnswerSchema = z.object({
  message: z.object({ text: z.string().min(1), metadata: ResearchAnswerBodySchema }),
});

export type ReadAnswerMessageResult =
  | { readonly outcome: 'found'; readonly message: AnswerMessage }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' | 'no_answer' };

/**
 * `Engine.readAnswerMessage` (design-engine.md, Contract Definitions): the stored message of the owner's investigation
 * once it is completed with an answer. `investigation_not_found` for another owner's or an unknown investigation,
 * `no_answer` for one not completed with an answer. A database read that fails throws.
 */
export async function readAnswerMessage(
  database: Database,
  { investigationId, resourceId }: { readonly investigationId: string; readonly resourceId: string },
): Promise<ReadAnswerMessageResult> {
  if (!z.uuid().safeParse(investigationId).success) {
    return { outcome: 'rejected', code: 'investigation_not_found' };
  }
  const status = await runs.readStatus(database, investigationId, resourceId);
  if (status === undefined) {
    return { outcome: 'rejected', code: 'investigation_not_found' };
  }
  if (status.investigationStatus !== 'completed' || status.run.answer === null) {
    return { outcome: 'rejected', code: 'no_answer' };
  }
  return { outcome: 'found', message: StoredAnswerSchema.parse(status.run.answer).message };
}
