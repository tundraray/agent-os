import type { TaskSpec } from '@agent-os/contracts';
import type { Clock, TaskContext, TaskScheduler } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import type { StopReason } from '../answer/code-answer.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { EngineLogger } from '../ports.js';
import { type GatherRequest, gatherKeyFields, SOURCE_FETCH_WORKFLOW } from './gather-key.js';

/** The runtime refuses a task deadline below this (`TaskBudget.deadlineMs`); the gate keeps more than it left (DC-3). */
const MIN_TASK_DEADLINE_MS = 1_000;
const MAX_TASK_DEADLINE_MS = 3_600_000;
/** A task of a model role holds three reservations of its call: the call, its retry after an invalid output, a margin. */
const RESERVATIONS_PER_TASK = 3;

/** Code of a source request whose snapshot could not be read: no task was proposed for it. */
const SOURCE_UNAVAILABLE = 'source_unavailable';

/**
 * A source request that created no task because the source's snapshot could not be read. It counts as a failed
 * collection: the controller observes it like a failed gather task, and the atoms it should have confirmed are missing.
 */
export const UnavailableRequestSchema = z.object({
  sourceId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  failureCode: z.literal(SOURCE_UNAVAILABLE),
});
export type UnavailableRequest = z.infer<typeof UnavailableRequestSchema>;

export interface GatherDeps {
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly sources: Pick<SourceRegistry, 'currentSnapshot'>;
  readonly clock: Clock;
  readonly logger: EngineLogger;
}

/** The decision being executed, as the attempt of the task that proposes its tasks sees it. */
export interface DecisionFrame {
  readonly ctx: TaskContext;
  readonly investigationId: string;
  readonly config: ProcessConfig;
  /** `notAfter` of the decision: the tasks it proposes get the time left until it. */
  readonly notAfter: Date;
  /** The accepted decision; the tasks that must be new for each decision carry it in their key. */
  readonly decisionId?: string;
  /** Subscriber key of the proposing task; the controller's by default. */
  readonly requesterKey?: string;
}

/** What proposing the tasks of a decision ended with. */
export type ProposedTasks =
  | {
      readonly outcome: 'proposed';
      readonly taskIds: readonly string[];
      /** Requests that created no task: their source's snapshot could not be read. */
      readonly unavailable: readonly UnavailableRequest[];
    }
  | { readonly outcome: 'stop'; readonly reason: StopReason }
  | { readonly outcome: 'abandon'; readonly cause: 'cancelled' };

/** A refused proposal the engine cannot act on: a defect, never an outcome of the investigation. */
class TaskProposalError extends Error {
  override readonly name = 'TaskProposalError';
}

const requesterKeyOf = (frame: DecisionFrame) => frame.requesterKey ?? `research.controller:${frame.ctx.taskId}`;

/** Runtime settings: the time left until the decision's `notAfter`, or null when it is below the runtime's minimum. */
export function taskDeadlineMs(deps: Pick<GatherDeps, 'clock'>, frame: DecisionFrame): number | null {
  const deadlineMs = Math.min(MAX_TASK_DEADLINE_MS, Math.floor(frame.notAfter.getTime() - deps.clock.now().getTime()));
  return deadlineMs <= MIN_TASK_DEADLINE_MS ? null : deadlineMs;
}

/** Runtime settings: `maxTokens` of an analysis, verification or synthesis task is three reservations of its role's call. */
export function roleTaskMaxTokens(role: ProcessConfig['roles']['worker']): number {
  return RESERVATIONS_PER_TASK * (role.windowTokens + role.marginTokens + role.maxOutputTokens);
}

/** Proposes one task through `TaskScheduler.propose` (ADR-0001) and maps the runtime's answer. */
export async function proposeSpec(deps: Pick<GatherDeps, 'scheduler'>, frame: DecisionFrame, spec: TaskSpec): Promise<ProposedTasks> {
  const proposed = await deps.scheduler.propose(spec, requesterKeyOf(frame));
  switch (proposed.outcome) {
    case 'created':
    case 'subscribed':
      return { outcome: 'proposed', taskIds: [proposed.taskId], unavailable: [] };
    case 'rejected':
      if (proposed.reason === 'investigation_inactive') return { outcome: 'abandon', cause: 'cancelled' };
      if (proposed.reason === 'budget_exhausted') return { outcome: 'stop', reason: 'budget_exhausted' };
      throw new TaskProposalError(`${spec.workflowType} of investigation ${frame.investigationId} refused: ${proposed.reason}`);
  }
}

type SnapshotRead =
  | { readonly outcome: 'read'; readonly snapshot: string }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'cancelled' };

/** The snapshot of the request's source; `unavailable` when the read failed without a cancel. */
async function snapshotOf(deps: GatherDeps, frame: DecisionFrame, request: GatherRequest): Promise<SnapshotRead> {
  try {
    return { outcome: 'read', snapshot: await deps.sources.currentSnapshot(request.sourceId, frame.ctx.signal) };
  } catch (error) {
    if (frame.ctx.signal.aborted) return { outcome: 'cancelled' };
    // KD-10: one warning per unreadable snapshot, with the source and the error class, without the request or a prompt.
    deps.logger.warn('source snapshot could not be read: the request is a failed collection', {
      investigationId: frame.investigationId,
      taskId: frame.ctx.taskId,
      sourceId: request.sourceId,
      errorClass: error instanceof Error ? error.name : typeof error,
      outcome: SOURCE_UNAVAILABLE,
    });
    return { outcome: 'unavailable' };
  }
}

/**
 * Proposes the `source.fetch` v1 task of a `requestEvidence` decision through `TaskScheduler.propose` (ADR-0001). The
 * snapshot is read from the source now and pinned in the input reference; the budget is the configuration's
 * `source.fetch` budget with the time left until the decision's `notAfter` (Runtime settings). The same request with
 * the same snapshot has the same dedup key (DC-4), so a repeated proposal — after a replan or by a replayed attempt —
 * is answered `subscribed` with the task already collected. A snapshot that cannot be read proposes no task: the
 * request comes back as unavailable, a failed collection with the code `source_unavailable`, and one warning is logged.
 */
export async function proposeGather(deps: GatherDeps, frame: DecisionFrame, request: GatherRequest): Promise<ProposedTasks> {
  const snapshot = await snapshotOf(deps, frame, request);
  if (snapshot.outcome === 'cancelled') return { outcome: 'abandon', cause: 'cancelled' };
  if (snapshot.outcome === 'unavailable') {
    const { sourceId, toolName, args } = request;
    return { outcome: 'proposed', taskIds: [], unavailable: [{ sourceId, toolName, args, failureCode: SOURCE_UNAVAILABLE }] };
  }
  const deadlineMs = taskDeadlineMs(deps, frame);
  if (deadlineMs === null) {
    return { outcome: 'stop', reason: 'deadline' };
  }
  return proposeSpec(deps, frame, {
    investigationId: frame.investigationId,
    ...gatherKeyFields(request, snapshot.snapshot),
    dependsOn: [],
    budget: { ...frame.config.limits.taskBudgets[SOURCE_FETCH_WORKFLOW], deadlineMs, maxTokens: 0 },
  });
}
