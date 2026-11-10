import { researchEngineRuns } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { abandonReservations } from '../model/ledger.js';
import type { InvestigationAnswer } from './code-answer.js';
import type { AnswerMessage } from './research-answer.builder.js';

/** Queries of the answer (ADR-0003: drizzle-orm). */
export const answerRepository = {
  /**
   * Writes the answer once, with its message in the same row (KD-8, «Запись ответа одна»), in the transaction of
   * `TaskContext.withAttemptGuard` (invariant 3), and returns the one recorded. DC-9: a reservation still open when the
   * answer is written will never be closed by its call.
   */
  async writeAnswer(tx: RuntimeTx, investigationId: string, answer: InvestigationAnswer, message: AnswerMessage): Promise<unknown> {
    await abandonReservations(tx, investigationId, { all: true });
    // The stored answer is the answer plus its `message` field (Data Model «Ответ движка»).
    const stored: InvestigationAnswer & { readonly message: AnswerMessage } = { ...answer, message };
    // Written once: an answer already recorded — by an earlier attempt that lost its outcome — is returned instead.
    const [written] = await tx
      .update(researchEngineRuns)
      .set({ answerId: answer.answerId, answer: stored })
      .where(and(eq(researchEngineRuns.investigationId, investigationId), isNull(researchEngineRuns.answerId)))
      .returning({ answer: researchEngineRuns.answer });
    if (written !== undefined) {
      return written.answer;
    }
    const [recorded] = await tx
      .select({ answer: researchEngineRuns.answer })
      .from(researchEngineRuns)
      .where(eq(researchEngineRuns.investigationId, investigationId));
    return recorded?.answer;
  },
};
