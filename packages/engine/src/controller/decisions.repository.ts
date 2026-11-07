import { type ResearchAnswerConfidence, ResearchAnswerConfidenceSchema } from '@agent-os/contracts';
import {
  type Database,
  researchClaims,
  researchDecisions,
  researchEngineRuns,
  researchInvestigations,
  researchPlanRevisions,
} from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { InvestigationAnswer } from '../answer/code-answer.js';

export type DecisionRow = typeof researchDecisions.$inferSelect;
export type PlanRevisionRow = typeof researchPlanRevisions.$inferSelect;

/** A controller output as the gate judged it; `step` and `callIndex` identify it, so a replay adds no copy. */
export interface NewDecision {
  readonly decisionId: string;
  readonly investigationId: string;
  readonly step: number;
  readonly callIndex: number;
  readonly status: 'accepted' | 'rejected';
  readonly rejectionReason: string | null;
  readonly decidedBy: 'model' | 'code';
  readonly kind: string | null;
  readonly decision: unknown;
  readonly planRevision: number;
  readonly notAfter: Date;
}

/**
 * KD-8: the one decision of an investigation without sources — `proposeAnswer`, accepted by code at the first step
 * after the plan; no model wrote it, so it has no refusal and no retry.
 */
export function proposeAnswerByCode(input: {
  readonly decisionId: string;
  readonly investigationId: string;
  readonly planRevision: number;
  readonly notAfter: Date;
}): NewDecision {
  return {
    ...input,
    step: 1,
    callIndex: 0,
    status: 'accepted',
    rejectionReason: null,
    decidedBy: 'code',
    kind: 'proposeAnswer',
    decision: {
      kind: 'proposeAnswer',
      rationale: 'no data source is connected: the answer is synthesized from model knowledge',
      evidenceIds: [],
      await: true,
    },
  };
}

/** The latest revision of a claim with the time it was written. */
export interface LatestClaimRow {
  readonly claimId: string;
  readonly text: string;
  readonly evidenceIds: string[];
  readonly status: string;
  readonly createdAt: Date;
}

/** A latest revision as the answer reads it: also its pointer and the group of a `supported` revision. */
export interface LatestClaimRevision extends LatestClaimRow {
  /** Null on revisions written before agent-quality. */
  readonly pointer: unknown;
  readonly confidence: ResearchAnswerConfidence | null;
}

const StoredConfidenceSchema = ResearchAnswerConfidenceSchema.nullable();

/**
 * Queries of the controller (ADR-0003: drizzle-orm). Reads go over the engine's database; every write takes the
 * transaction of `TaskContext.withAttemptGuard` (invariant 3). The runtime's `research_investigations` is only read.
 */
export const controllerRepository = {
  /** The engine row with the investigation's thread and query; `undefined` without an engine row. */
  async readRun(db: Database, investigationId: string) {
    const [row] = await db
      .select({ run: researchEngineRuns, threadId: researchInvestigations.threadId, query: researchInvestigations.query })
      .from(researchEngineRuns)
      .innerJoin(researchInvestigations, eq(researchInvestigations.investigationId, researchEngineRuns.investigationId))
      .where(eq(researchEngineRuns.investigationId, investigationId));
    return row;
  },

  async latestPlanRevision(db: Database, investigationId: string): Promise<PlanRevisionRow | undefined> {
    const [row] = await db
      .select()
      .from(researchPlanRevisions)
      .where(eq(researchPlanRevisions.investigationId, investigationId))
      .orderBy(desc(researchPlanRevisions.revision))
      .limit(1);
    return row;
  },

  /** Inserts a plan revision; a revision a replayed attempt already wrote is left as it is (revisions only append). */
  async insertPlanRevision(
    tx: RuntimeTx,
    revision: { investigationId: string; revision: number; plan: unknown; reason: string | null },
  ): Promise<void> {
    await tx.insert(researchPlanRevisions).values(revision).onConflictDoNothing();
  },

  /** Every controller output of the investigation, by step and call. */
  decisionsOf(db: Database, investigationId: string): Promise<DecisionRow[]> {
    return db
      .select()
      .from(researchDecisions)
      .where(eq(researchDecisions.investigationId, investigationId))
      .orderBy(asc(researchDecisions.step), asc(researchDecisions.callIndex));
  },

  /** Records a judged output; the same step and call written by a replayed attempt is not written again. */
  async insertDecision(tx: RuntimeTx, decision: NewDecision): Promise<void> {
    await tx.insert(researchDecisions).values(decision).onConflictDoNothing();
  },

  /** The latest revision of every claim of the investigation; a group the closed list does not name is a defect. */
  async latestClaims(db: Database, investigationId: string): Promise<LatestClaimRevision[]> {
    const rows = await db
      .selectDistinctOn([researchClaims.claimId], {
        claimId: researchClaims.claimId,
        text: researchClaims.text,
        evidenceIds: researchClaims.evidenceIds,
        status: researchClaims.status,
        pointer: researchClaims.pointer,
        confidence: researchClaims.confidence,
        createdAt: researchClaims.createdAt,
      })
      .from(researchClaims)
      .where(eq(researchClaims.investigationId, investigationId))
      .orderBy(asc(researchClaims.claimId), desc(researchClaims.seq));
    return rows.map((row) => ({ ...row, confidence: StoredConfidenceSchema.parse(row.confidence) }));
  },

  /**
   * Writes the answer once: an answer already recorded — by an earlier attempt that lost its outcome — is returned
   * instead, so the task ends with the same `answerId`.
   */
  async writeAnswer(tx: RuntimeTx, investigationId: string, answer: InvestigationAnswer): Promise<unknown> {
    const [written] = await tx
      .update(researchEngineRuns)
      .set({ answerId: answer.answerId, answer })
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
