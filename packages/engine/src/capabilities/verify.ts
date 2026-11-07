import { z } from 'zod';
import type { Decision } from '../controller/decision.schema.js';
import { type DecisionFrame, type GatherDeps, type ProposedTasks, proposeSpec, roleTaskMaxTokens, taskDeadlineMs } from './gather.js';

export const VERIFY_WORKFLOW = 'research.verify';
/** Version 2: one claim per task, one verifier call over the records of its pointer (KD-1). */
const VERIFY_WORKFLOW_VERSION = 2;

/** An accepted `requestVerification` decision. */
type VerificationRequest = Extract<Decision, { kind: 'requestVerification' }>;

/**
 * Input of `research.verify` v2: the decision that asked for the check, the one claim to check, and that decision's
 * `notAfter` (Contract Definitions, `research.verify` версии 2).
 */
export const VerifyInputSchema = z.object({
  decisionId: z.uuid(),
  claimId: z.uuid(),
  notAfter: z.iso.datetime(),
});

/** A refused proposal the engine cannot act on: a defect, never an outcome of the investigation. */
class TaskProposalError extends Error {
  override readonly name = 'TaskProposalError';
}

/**
 * Proposes a `research.verify` v2 task per claim of a `requestVerification` decision, in the order the decision names
 * them (a repeated id once): three reservations of the verifier call, one tool call (the least a task budget holds; the
 * task makes none), no retry and the time left until the decision's `notAfter` (Runtime settings). The decision is
 * still one verification round — rounds are counted by decisions, not by tasks. The decision id is in the input, so a
 * later round over the same claim is a new task while a replayed proposal of this one is `subscribed`.
 */
export async function proposeVerification(deps: GatherDeps, frame: DecisionFrame, decision: VerificationRequest): Promise<ProposedTasks> {
  const { decisionId } = frame;
  if (decisionId === undefined) {
    throw new TaskProposalError(`verification of investigation ${frame.investigationId} has no decision`);
  }
  const taskIds: string[] = [];
  for (const claimId of new Set(decision.claimIds)) {
    const deadlineMs = taskDeadlineMs(deps, frame);
    if (deadlineMs === null) {
      return { outcome: 'stop', reason: 'deadline' };
    }
    const proposed = await proposeSpec(deps, frame, {
      investigationId: frame.investigationId,
      workflowType: VERIFY_WORKFLOW,
      workflowVersion: VERIFY_WORKFLOW_VERSION,
      input: { decisionId, claimId, notAfter: frame.notAfter.toISOString() },
      inputRefs: [],
      expectedOutput: {
        description: `A new revision of claim ${claimId}, checked against the records of its pointer`,
        completeness: 'all',
      },
      dependsOn: [],
      budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs, maxTokens: roleTaskMaxTokens(frame.config.roles.verifier) },
    });
    if (proposed.outcome !== 'proposed') return proposed;
    taskIds.push(...proposed.taskIds);
  }
  return { outcome: 'proposed', taskIds, unavailable: [] };
}
