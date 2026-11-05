import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Decision } from '../controller/decision.schema.js';
import {
  type DecisionFrame,
  type GatherDeps,
  type ProposedTasks,
  proposeGather,
  proposeSpec,
  roleTaskMaxTokens,
  taskDeadlineMs,
  type UnavailableRequest,
} from './gather.js';

export const ANALYZE_WORKFLOW = 'research.analyze';

/** An accepted `requestAnalysis` decision. */
type AnalysisRequest = Extract<Decision, { kind: 'requestAnalysis' }>;

/**
 * Input of `research.analyze` v1: the sub-question, the gather task whose evidence it reads, and the `notAfter` of the
 * decision that proposed it (Contract Definitions, handlers) — no model call starts at or after it.
 */
export const AnalyzeInputSchema = z.object({
  subquestion: z.string().min(1),
  gatherTaskId: z.uuid(),
  notAfter: z.iso.datetime(),
});

/** A refused proposal the engine cannot act on: a defect, never an outcome of the investigation. */
class TaskProposalError extends Error {
  override readonly name = 'TaskProposalError';
}

/**
 * Proposes the tasks of a `requestAnalysis` decision: per sub-question its gather task (`source.fetch`, as
 * `requestEvidence` proposes it) and a `research.analyze` v1 task that depends on it, with three reservations of the
 * worker call, one tool call, no retry and the time left until the decision's `notAfter` (Runtime settings). The
 * proposed ids come in that order, gather then analysis, sub-question by sub-question. A sub-question whose source
 * gives no snapshot gets neither task: its request comes back as unavailable (a failed collection).
 */
export async function proposeAnalysis(deps: GatherDeps, frame: DecisionFrame, decision: AnalysisRequest): Promise<ProposedTasks> {
  const taskIds: string[] = [];
  const unavailable: UnavailableRequest[] = [];
  for (const subquestion of decision.subquestions) {
    const gathered = await proposeGather(deps, frame, {
      kind: 'requestEvidence',
      rationale: decision.rationale,
      evidenceIds: [],
      await: decision.await,
      sourceId: subquestion.sourceId,
      toolName: subquestion.toolName,
      args: subquestion.args,
      completeness: subquestion.completeness,
    });
    if (gathered.outcome !== 'proposed') return gathered;
    if (gathered.unavailable.length > 0) {
      unavailable.push(...gathered.unavailable);
      continue;
    }
    const [gatherTaskId] = gathered.taskIds;
    if (gatherTaskId === undefined) {
      throw new TaskProposalError(`gather of investigation ${frame.investigationId} proposed no task`);
    }
    const analyzed = await proposeAnalysisTask(deps, frame, {
      subquestion: subquestion.text,
      gatherTaskId,
      completeness: subquestion.completeness,
    });
    if (analyzed.outcome !== 'proposed') return analyzed;
    taskIds.push(gatherTaskId, ...analyzed.taskIds);
  }
  return { outcome: 'proposed', taskIds, unavailable };
}

async function proposeAnalysisTask(
  deps: GatherDeps,
  frame: DecisionFrame,
  request: { readonly subquestion: string; readonly gatherTaskId: string; readonly completeness: 'all' | 'sample' },
): Promise<ProposedTasks> {
  const deadlineMs = taskDeadlineMs(deps, frame);
  if (deadlineMs === null) {
    return { outcome: 'stop', reason: 'deadline' };
  }
  // A digest keeps the description within its 2 000 characters whatever the length of the sub-question.
  const digest = createHash('sha256').update(request.subquestion).digest('hex');
  return proposeSpec(deps, frame, {
    investigationId: frame.investigationId,
    workflowType: ANALYZE_WORKFLOW,
    workflowVersion: 1,
    input: { subquestion: request.subquestion, gatherTaskId: request.gatherTaskId, notAfter: frame.notAfter.toISOString() },
    inputRefs: [],
    expectedOutput: {
      description: `Claims with atoms and evidence ids answering the sub-question with sha256 ${digest}`,
      completeness: request.completeness,
    },
    dependsOn: [request.gatherTaskId],
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs, maxTokens: roleTaskMaxTokens(frame.config.roles.worker) },
  });
}
