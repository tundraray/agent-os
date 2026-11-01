import { researchDecisions } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { eq } from 'drizzle-orm';

/**
 * Records the tasks an accepted decision proposed on its row (`research_decisions.proposed_task_ids`), in the
 * transaction of `TaskContext.withAttemptGuard`. A decision with recorded tasks has been applied: a replayed or woken
 * attempt reads them instead of proposing again.
 */
export async function recordProposedTasks(tx: RuntimeTx, decisionId: string, taskIds: readonly string[]): Promise<void> {
  await tx.update(researchDecisions).set({ proposedTaskIds: [...taskIds] }).where(eq(researchDecisions.decisionId, decisionId));
}
