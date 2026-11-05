import { type Database, researchDecisions } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, count, eq } from 'drizzle-orm';
import { controllerRepository } from '../controller/decisions.repository.js';
import { abandonReservations } from '../model/ledger.js';
import type { InvestigationAnswer } from './code-answer.js';

/** Queries of the answer, by code or by the synthesis (ADR-0003: drizzle-orm). */
export const answerRepository = {
  /** Verification rounds used: the accepted `requestVerification` decisions, as the gate counts them. */
  async verifyRoundsUsed(db: Database, investigationId: string): Promise<number> {
    const [row] = await db
      .select({ rounds: count() })
      .from(researchDecisions)
      .where(
        and(
          eq(researchDecisions.investigationId, investigationId),
          eq(researchDecisions.status, 'accepted'),
          eq(researchDecisions.kind, 'requestVerification'),
        ),
      );
    return row?.rounds ?? 0;
  },

  /**
   * Writes the answer once, in the transaction of `TaskContext.withAttemptGuard` (invariant 3), and returns the one
   * recorded. DC-9: a reservation still open when the answer is written will never be closed by its call.
   */
  async writeAnswer(tx: RuntimeTx, investigationId: string, answer: InvestigationAnswer): Promise<unknown> {
    await abandonReservations(tx, investigationId, { all: true });
    return controllerRepository.writeAnswer(tx, investigationId, answer);
  },
};
