import { randomUUID } from 'node:crypto';
import type { Coverage } from '@agent-os/contracts';
import { researchClaims } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { asc, eq } from 'drizzle-orm';
import type { WorkerClaim } from './claim.schema.js';

/** The claims one task writes from its model answer. */
export interface TaskClaims {
  readonly investigationId: string;
  readonly taskId: string;
  /** Coverage of the collection the claims rest on; code carries it, the model cannot widen it (AC-05.3). */
  readonly coverage: Coverage | null;
  readonly claims: readonly WorkerClaim[];
}

/**
 * Claim revisions (ADR-0003: drizzle-orm). Every write takes the transaction of `TaskContext.withAttemptGuard`
 * (invariant 3); revisions are only appended (invariant 9).
 */
export const claimsRepository = {
  /**
   * Writes the first revision of each claim, `unverified`, numbered by its place in the task's output; returns the
   * `claimId`s in that order. A revision is unique by its task and number, so a later attempt that replays the same
   * answer from the checkpoint adds nothing and gets the ids written first.
   */
  async writeTaskClaims(tx: RuntimeTx, input: TaskClaims): Promise<string[]> {
    if (input.claims.length > 0) {
      await tx
        .insert(researchClaims)
        .values(
          input.claims.map((claim, claimIndex) => ({
            claimRevisionId: randomUUID(),
            investigationId: input.investigationId,
            claimId: randomUUID(),
            taskId: input.taskId,
            claimIndex,
            text: claim.text,
            atoms: claim.atoms,
            evidenceIds: [...claim.evidenceIds],
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
};
