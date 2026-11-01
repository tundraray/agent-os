import type { TaskSpec } from '@agent-os/contracts';
import type { Clock, TaskContext, TaskScheduler } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import type { StopReason } from '../answer/code-answer.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import { type GatherRequest, gatherKeyFields, SOURCE_FETCH_WORKFLOW } from './gather-key.js';

/** The runtime refuses a task deadline below this (`TaskBudget.deadlineMs`); the gate keeps more than it left (DC-3). */
const MIN_TASK_DEADLINE_MS = 1_000;
const MAX_TASK_DEADLINE_MS = 3_600_000;

export interface GatherDeps {
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly sources: Pick<SourceRegistry, 'currentSnapshot'>;
  readonly clock: Clock;
}

/** The decision being executed, as the attempt of its controller task sees it. */
export interface DecisionFrame {
  readonly ctx: TaskContext;
  readonly investigationId: string;
  readonly config: ProcessConfig;
  /** `notAfter` of the decision: the tasks it proposes get the time left until it. */
  readonly notAfter: Date;
}

/** What proposing the tasks of a decision ended with. */
export type ProposedTasks =
  | { readonly outcome: 'proposed'; readonly taskIds: readonly string[] }
  | { readonly outcome: 'stop'; readonly reason: StopReason }
  | { readonly outcome: 'abandon'; readonly cause: 'cancelled' };

/** A refused proposal the engine cannot act on: a defect, never an outcome of the investigation. */
class TaskProposalError extends Error {
  override readonly name = 'TaskProposalError';
}

/** Subscriber key of the tasks a controller task proposes. */
const requesterKeyOf = (ctx: TaskContext) => `research.controller:${ctx.taskId}`;

/**
 * Proposes the `source.fetch` v1 task of a `requestEvidence` decision through `TaskScheduler.propose` (ADR-0001). The
 * snapshot is read from the source now and pinned in the input reference; the budget is the configuration's
 * `source.fetch` budget with the time left until the decision's `notAfter` (Runtime settings). The same request with
 * the same snapshot has the same dedup key (DC-4), so a repeated proposal — after a replan or by a replayed attempt —
 * is answered `subscribed` with the task already collected.
 */
export async function proposeGather(deps: GatherDeps, frame: DecisionFrame, request: GatherRequest): Promise<ProposedTasks> {
  const { ctx } = frame;
  const snapshot = await deps.sources.currentSnapshot(request.sourceId, ctx.signal);
  const deadlineMs = Math.min(MAX_TASK_DEADLINE_MS, Math.floor(frame.notAfter.getTime() - deps.clock.now().getTime()));
  if (deadlineMs <= MIN_TASK_DEADLINE_MS) {
    return { outcome: 'stop', reason: 'deadline' };
  }
  const spec: TaskSpec = {
    investigationId: frame.investigationId,
    ...gatherKeyFields(request, snapshot),
    dependsOn: [],
    budget: { ...frame.config.limits.taskBudgets[SOURCE_FETCH_WORKFLOW], deadlineMs, maxTokens: 0 },
  };
  const proposed = await deps.scheduler.propose(spec, requesterKeyOf(ctx));
  switch (proposed.outcome) {
    case 'created':
    case 'subscribed':
      return { outcome: 'proposed', taskIds: [proposed.taskId] };
    case 'rejected':
      if (proposed.reason === 'investigation_inactive') return { outcome: 'abandon', cause: 'cancelled' };
      if (proposed.reason === 'budget_exhausted') return { outcome: 'stop', reason: 'budget_exhausted' };
      throw new TaskProposalError(`source.fetch of investigation ${frame.investigationId} refused: ${proposed.reason}`);
  }
}
