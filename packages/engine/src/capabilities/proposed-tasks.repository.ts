import { researchDecisions } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type UnavailableRequest, UnavailableRequestSchema } from './gather.js';

/** The field of a stored decision that lists its requests whose source gave no snapshot. */
const DecisionUnavailableSchema = z.object({ unavailableRequests: z.array(UnavailableRequestSchema).default([]) });

/**
 * Records what an accepted decision proposed on its row (`research_decisions.proposed_task_ids`), in the transaction
 * of `TaskContext.withAttemptGuard`; requests that created no task are added to the stored decision as
 * `unavailableRequests`. A decision with either recorded has been applied: a replayed or woken attempt reads them
 * instead of proposing again.
 */
export async function recordProposedTasks(
  tx: RuntimeTx,
  decisionId: string,
  proposed: { readonly taskIds: readonly string[]; readonly unavailable: readonly UnavailableRequest[] },
): Promise<void> {
  const unavailable = JSON.stringify({ unavailableRequests: proposed.unavailable });
  await tx
    .update(researchDecisions)
    .set({
      proposedTaskIds: [...proposed.taskIds],
      ...(proposed.unavailable.length > 0 ? { decision: sql`${researchDecisions.decision} || ${unavailable}::jsonb` } : {}),
    })
    .where(eq(researchDecisions.decisionId, decisionId));
}

/** The requests of a stored decision that created no task (a failed collection with `source_unavailable`). */
export function unavailableRequestsOf(decision: unknown): UnavailableRequest[] {
  const parsed = DecisionUnavailableSchema.safeParse(decision);
  return parsed.success ? parsed.data.unavailableRequests : [];
}
