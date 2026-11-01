import { createHash } from 'node:crypto';
import type { TaskSpec } from '@agent-os/contracts';
import { z } from 'zod';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { Decision } from '../controller/decision.schema.js';
import { type DecisionFrame, type GatherDeps, type ProposedTasks, proposeGather } from './gather.js';

export const ANALYZE_WORKFLOW = 'research.analyze';

/** The runtime refuses a task deadline below this (`TaskBudget.deadlineMs`). */
const MIN_TASK_DEADLINE_MS = 1_000;
const MAX_TASK_DEADLINE_MS = 3_600_000;
/** An analysis task holds three reservations of its call: the call, its retry after an invalid output, a margin. */
const RESERVATIONS_PER_TASK = 3;

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

/** Runtime settings: `maxTokens` of an analysis task is three reservations of the worker call. */
function analysisMaxTokens(config: ProcessConfig): number {
  const worker = config.roles.worker;
  return RESERVATIONS_PER_TASK * (worker.windowTokens + worker.marginTokens + worker.maxOutputTokens);
}

/**
 * Proposes the tasks of a `requestAnalysis` decision: per sub-question its gather task (`source.fetch`, as
 * `requestEvidence` proposes it) and a `research.analyze` v1 task that depends on it, with three reservations of the
 * worker call, one tool call, no retry and the time left until the decision's `notAfter` (Runtime settings). The
 * proposed ids come in that order, gather then analysis, sub-question by sub-question.
 */
export async function proposeAnalysis(deps: GatherDeps, frame: DecisionFrame, decision: AnalysisRequest): Promise<ProposedTasks> {
  const taskIds: string[] = [];
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
  return { outcome: 'proposed', taskIds };
}

async function proposeAnalysisTask(
  deps: GatherDeps,
  frame: DecisionFrame,
  request: { readonly subquestion: string; readonly gatherTaskId: string; readonly completeness: 'all' | 'sample' },
): Promise<ProposedTasks> {
  const deadlineMs = Math.min(MAX_TASK_DEADLINE_MS, Math.floor(frame.notAfter.getTime() - deps.clock.now().getTime()));
  if (deadlineMs <= MIN_TASK_DEADLINE_MS) {
    return { outcome: 'stop', reason: 'deadline' };
  }
  // A digest keeps the description within its 2 000 characters whatever the length of the sub-question.
  const digest = createHash('sha256').update(request.subquestion).digest('hex');
  const spec: TaskSpec = {
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
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs, maxTokens: analysisMaxTokens(frame.config) },
  };
  const proposed = await deps.scheduler.propose(spec, `research.controller:${frame.ctx.taskId}`);
  switch (proposed.outcome) {
    case 'created':
    case 'subscribed':
      return { outcome: 'proposed', taskIds: [proposed.taskId] };
    case 'rejected':
      if (proposed.reason === 'investigation_inactive') return { outcome: 'abandon', cause: 'cancelled' };
      if (proposed.reason === 'budget_exhausted') return { outcome: 'stop', reason: 'budget_exhausted' };
      throw new TaskProposalError(`research.analyze of investigation ${frame.investigationId} refused: ${proposed.reason}`);
  }
}
