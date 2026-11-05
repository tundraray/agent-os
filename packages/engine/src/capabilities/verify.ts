import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Decision } from '../controller/decision.schema.js';
import { type DecisionFrame, type GatherDeps, type ProposedTasks, proposeSpec, roleTaskMaxTokens, taskDeadlineMs } from './gather.js';

export const VERIFY_WORKFLOW = 'research.verify';

/** An accepted `requestVerification` decision. */
type VerificationRequest = Extract<Decision, { kind: 'requestVerification' }>;

/**
 * Input of `research.verify` v1: the decision that asked for the round (each round is a task of its own), the claims to
 * verify, and that decision's `notAfter` (Contract Definitions, handlers).
 */
export const VerifyInputSchema = z.object({
  decisionId: z.uuid(),
  claimIds: z.array(z.uuid()).min(1),
  notAfter: z.iso.datetime(),
});

/** A refused proposal the engine cannot act on: a defect, never an outcome of the investigation. */
class TaskProposalError extends Error {
  override readonly name = 'TaskProposalError';
}

/**
 * Proposes the `research.verify` v1 task of a `requestVerification` decision: three reservations of the verifier call,
 * one tool call, no retry and the time left until the decision's `notAfter` (Runtime settings). The decision id is in
 * the input, so a later round over the same claims is a new task while a replayed proposal of this one is `subscribed`.
 */
export async function proposeVerification(deps: GatherDeps, frame: DecisionFrame, decision: VerificationRequest): Promise<ProposedTasks> {
  if (frame.decisionId === undefined) {
    throw new TaskProposalError(`verification of investigation ${frame.investigationId} has no decision`);
  }
  const deadlineMs = taskDeadlineMs(deps, frame);
  if (deadlineMs === null) {
    return { outcome: 'stop', reason: 'deadline' };
  }
  const digest = createHash('sha256').update(decision.claimIds.join(',')).digest('hex');
  return proposeSpec(deps, frame, {
    investigationId: frame.investigationId,
    workflowType: VERIFY_WORKFLOW,
    workflowVersion: 1,
    input: { decisionId: frame.decisionId, claimIds: [...decision.claimIds], notAfter: frame.notAfter.toISOString() },
    inputRefs: [],
    expectedOutput: {
      description: `New revisions of the claims with sha256 ${digest}, checked against source records`,
      completeness: 'all',
    },
    dependsOn: [],
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs, maxTokens: roleTaskMaxTokens(frame.config.roles.verifier) },
  });
}
