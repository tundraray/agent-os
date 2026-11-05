import { z } from 'zod';
import { type DecisionFrame, type GatherDeps, type ProposedTasks, proposeSpec, roleTaskMaxTokens, taskDeadlineMs } from './gather.js';

export const SYNTHESIZE_WORKFLOW = 'research.synthesize';

/**
 * Input of `research.synthesize` v1: the `proposeAnswer` decision it answers — each proposal is a task of its own, so
 * the answer proposed again after `needs_verification` is a new task — and that decision's `notAfter` (Contract
 * Definitions, handlers).
 */
export const SynthesizeInputSchema = z.object({
  decisionId: z.uuid(),
  notAfter: z.iso.datetime(),
});

/** A refused proposal the engine cannot act on: a defect, never an outcome of the investigation. */
class TaskProposalError extends Error {
  override readonly name = 'TaskProposalError';
}

/**
 * Proposes the `research.synthesize` v1 task of a `proposeAnswer` decision: three reservations of the synthesis call,
 * one tool call, no retry and the time left until the decision's `notAfter` (Runtime settings).
 */
export async function proposeSynthesis(deps: GatherDeps, frame: DecisionFrame): Promise<ProposedTasks> {
  if (frame.decisionId === undefined) {
    throw new TaskProposalError(`synthesis of investigation ${frame.investigationId} has no decision`);
  }
  const deadlineMs = taskDeadlineMs(deps, frame);
  if (deadlineMs === null) {
    return { outcome: 'stop', reason: 'deadline' };
  }
  return proposeSpec(deps, frame, {
    investigationId: frame.investigationId,
    workflowType: SYNTHESIZE_WORKFLOW,
    workflowVersion: 1,
    input: { decisionId: frame.decisionId, notAfter: frame.notAfter.toISOString() },
    inputRefs: [],
    expectedOutput: {
      description: `The answer of the investigation for decision ${frame.decisionId}, with the claims that passed the reference gateway`,
      completeness: 'all',
    },
    dependsOn: [],
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs, maxTokens: roleTaskMaxTokens(frame.config.roles.synthesis) },
  });
}
