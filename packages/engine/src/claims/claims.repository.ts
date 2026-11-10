import { randomUUID } from 'node:crypto';
import type { Coverage } from '@agent-os/contracts';
import { type Database, researchClaims } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { pointerPages, type WorkerClaim } from './claim.schema.js';

/** The claims one task writes from its model answer. */
export interface TaskClaims {
  readonly investigationId: string;
  readonly taskId: string;
  /** Coverage of the collection the claims rest on; code carries it, the model cannot widen it (AC-05.3). */
  readonly coverage: Coverage | null;
  readonly claims: readonly WorkerClaim[];
  /** The number of the first claim, for a task that writes claims in several calls; 0 by default. */
  readonly firstClaimIndex?: number;
  /** The ids of the claims, one per claim in order, when the caller decided them; random by default. */
  readonly claimIds?: readonly string[];
}

/**
 * A revision a check task appends to a claim (design-engine.md, Data Model: research_claims): the decision of
 * `decideClaim`, or `insufficient` decided before the call, with the claim's pointer as it was checked.
 */
export interface VerifiedRevision {
  readonly claimId: string;
  readonly text: string;
  /**
   * Each atom with its verdict `found`, `missing` or `contradicted` and, as `records`, the numbers of the pointed records
   * it was found in, when the value check ran; as stored otherwise.
   */
  readonly atoms: readonly unknown[];
  /** The basis: the pages of the records the status rests on. */
  readonly evidenceIds: readonly string[];
  /** The scope of the records the claim rests on, carried from its earlier revision. */
  readonly coverage: Coverage | null;
  readonly status: 'supported' | 'refuted' | 'insufficient' | 'causal';
  /** The pointer of the checked revision, as it was stored there. */
  readonly pointer: unknown;
  /** The type the verifier's assessment gave; null when there was none in form. */
  readonly claimType: string | null;
  /** The verifier's answer and whether it broke the form; null when no call was made. */
  readonly assessment: unknown;
  /** The confidence group of a `supported` revision; null for every other status. */
  readonly confidence: string | null;
}

/** The latest revision of a claim, as the verifier reads it. */
export type ClaimRevisionRow = typeof researchClaims.$inferSelect;

/**
 * Claim revisions (ADR-0003: drizzle-orm). Every write takes the transaction of `TaskContext.withAttemptGuard`
 * (invariant 3); revisions are only appended (invariant 9).
 */
export const claimsRepository = {
  /**
   * Writes the first revision of each claim, `unverified`, with its pointer as given and the pointer's pages in
   * `evidenceIds` (Data Model), numbered by its place in the task's output; returns the
   * `claimId`s in that order. A revision is unique by its task and number, so a later attempt that replays the same
   * answer from the checkpoint adds nothing and gets the ids written first.
   */
  async writeTaskClaims(tx: RuntimeTx, input: TaskClaims): Promise<string[]> {
    if (input.claims.length > 0) {
      await tx
        .insert(researchClaims)
        .values(
          input.claims.map((claim, position) => ({
            claimRevisionId: randomUUID(),
            investigationId: input.investigationId,
            claimId: input.claimIds?.[position] ?? randomUUID(),
            taskId: input.taskId,
            claimIndex: (input.firstClaimIndex ?? 0) + position,
            text: claim.text,
            atoms: claim.atoms,
            pointer: claim.pointer,
            evidenceIds: pointerPages(claim.pointer),
            coverage: input.coverage,
            status: 'unverified',
          })),
        )
        .onConflictDoNothing({ target: [researchClaims.taskId, researchClaims.claimIndex] });
    }
    const written = await tx
      .select({ claimId: researchClaims.claimId })
      .from(researchClaims)
      .where(eq(researchClaims.taskId, input.taskId))
      .orderBy(asc(researchClaims.claimIndex));
    return written.map((row) => row.claimId);
  },

  /** The number after the last claim of the task, in the caller's transaction; 0 for a task without claims. */
  async nextClaimIndex(tx: RuntimeTx, taskId: string): Promise<number> {
    const [last] = await tx
      .select({ claimIndex: researchClaims.claimIndex })
      .from(researchClaims)
      .where(eq(researchClaims.taskId, taskId))
      .orderBy(desc(researchClaims.claimIndex))
      .limit(1);
    return last === undefined ? 0 : last.claimIndex + 1;
  },

  /** The latest revision of each of `claimIds` that belongs to the investigation; ids of other investigations are absent. */
  latestRevisions(db: Database | RuntimeTx, investigationId: string, claimIds: readonly string[]): Promise<ClaimRevisionRow[]> {
    return db
      .selectDistinctOn([researchClaims.claimId])
      .from(researchClaims)
      .where(and(eq(researchClaims.investigationId, investigationId), inArray(researchClaims.claimId, [...claimIds])))
      .orderBy(asc(researchClaims.claimId), desc(researchClaims.seq));
  },

  /**
   * Appends the revisions of one check task, numbered by their place in its input (invariant 9: the earlier revisions
   * stay as they were). Unique by task and number, so a replayed attempt adds nothing.
   */
  async appendRevisions(
    tx: RuntimeTx,
    input: { readonly investigationId: string; readonly taskId: string; readonly revisions: readonly VerifiedRevision[] },
  ): Promise<void> {
    if (input.revisions.length === 0) return;
    await tx
      .insert(researchClaims)
      .values(
        input.revisions.map((revision, claimIndex) => ({
          claimRevisionId: randomUUID(),
          investigationId: input.investigationId,
          claimId: revision.claimId,
          taskId: input.taskId,
          claimIndex,
          text: revision.text,
          atoms: revision.atoms,
          evidenceIds: [...revision.evidenceIds],
          coverage: revision.coverage,
          status: revision.status,
          pointer: revision.pointer,
          claimType: revision.claimType,
          assessment: revision.assessment,
          confidence: revision.confidence,
        })),
      )
      .onConflictDoNothing({ target: [researchClaims.taskId, researchClaims.claimIndex] });
  },
};
