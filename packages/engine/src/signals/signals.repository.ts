import { randomUUID } from 'node:crypto';
import { type Database, researchDecisions, researchEngineRuns, researchSignals } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, exists, inArray, isNull } from 'drizzle-orm';
import type { InputSignal } from './signal-registry.js';

/**
 * Queries of the external signals (ADR-0003: drizzle-orm). A signal is unread until a decision reads it; the decision
 * that read it is recorded on the signal (`read_by_decision_id`).
 */
export const signalsRepository = {
  /**
   * Records a checked signal of the owner's investigation; `undefined`, with no row written, when the investigation
   * has no engine row of that owner.
   */
  async record(
    db: Database,
    signal: { investigationId: string; resourceId: string; kind: string; payload: unknown },
  ): Promise<string | undefined> {
    const [owned] = await db
      .select({ investigationId: researchEngineRuns.investigationId })
      .from(researchEngineRuns)
      .where(
        and(
          eq(researchEngineRuns.investigationId, signal.investigationId),
          eq(researchEngineRuns.resourceId, signal.resourceId),
        ),
      );
    if (owned === undefined) {
      return undefined;
    }
    const signalId = randomUUID();
    await db
      .insert(researchSignals)
      .values({ signalId, investigationId: owned.investigationId, kind: signal.kind, payload: signal.payload });
    return signalId;
  },

  /** Signals no decision has read yet, oldest first. */
  unread(db: Database, investigationId: string): Promise<InputSignal[]> {
    return db
      .select({
        signalId: researchSignals.signalId,
        kind: researchSignals.kind,
        recordedAt: researchSignals.recordedAt,
        payload: researchSignals.payload,
      })
      .from(researchSignals)
      .where(and(eq(researchSignals.investigationId, investigationId), isNull(researchSignals.readByDecisionId)))
      .orderBy(asc(researchSignals.recordedAt), asc(researchSignals.signalId));
  },

  /**
   * Marks the signals as read by the decision, in the decision's guarded transaction. Only a decision that exists is
   * recorded — a replayed write that added no decision marks nothing — and a signal another decision read stays its.
   */
  async markRead(tx: RuntimeTx, decisionId: string, signalIds: readonly string[]): Promise<void> {
    if (signalIds.length === 0) {
      return;
    }
    await tx
      .update(researchSignals)
      .set({ readByDecisionId: decisionId })
      .where(
        and(
          inArray(researchSignals.signalId, [...signalIds]),
          isNull(researchSignals.readByDecisionId),
          exists(tx.select().from(researchDecisions).where(eq(researchDecisions.decisionId, decisionId))),
        ),
      );
  },
};
