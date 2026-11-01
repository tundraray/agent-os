import type { Task } from '@agent-os/contracts';
import type { DecisionKind } from '../config/capabilities.js';
import type { ClaimLine, ControllerMaterial, TaskCount } from '../context/role-packets.js';
import { type InputSignal, toInputSignal } from '../signals/signal-registry.js';
import type { DecisionRow, LatestClaimRow, PlanRevisionRow } from './decisions.repository.js';

const FINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/** Tasks of the investigation other than the controller's own. */
export function otherTasks(tasks: readonly Task[], controllerTaskId: string): Task[] {
  return tasks.filter((task) => task.taskId !== controllerTaskId);
}

export function openTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => !FINAL_STATUSES.has(task.status));
}

/**
 * Trailing steps without novelty (Terms: new evidence or a new claim revision after the previous step). The interval
 * after an accepted decision is new when a claim revision was written after it and before the next one, or when a task it
 * proposed returned evidence. The intervals are counted back from the latest one.
 */
export function stepsWithoutNovelty(
  accepted: readonly DecisionRow[],
  claims: readonly LatestClaimRow[],
  tasks: readonly Task[],
): number {
  const evidenceBy = new Map(tasks.map((task) => [task.taskId, task.outputRefs.length]));
  let count = 0;
  for (let index = accepted.length - 1; index >= 0; index -= 1) {
    const from = accepted[index]!;
    const until = accepted[index + 1]?.createdAt;
    const newClaim = claims.some((claim) => claim.createdAt > from.createdAt && (until === undefined || claim.createdAt <= until));
    const newEvidence = from.proposedTaskIds.some((taskId) => (evidenceBy.get(taskId) ?? 0) > 0);
    if (newClaim || newEvidence) {
      break;
    }
    count += 1;
  }
  return count;
}

export interface DecisionInputParts {
  readonly plan: PlanRevisionRow;
  readonly budget: Readonly<Record<string, number>>;
  readonly admissible: readonly DecisionKind[];
  /** Signals no decision has read yet. */
  readonly signals: readonly InputSignal[];
  readonly stepsWithoutNovelty: number;
  /** Tasks other than the controller. */
  readonly tasks: readonly Task[];
  readonly claims: readonly LatestClaimRow[];
  /** The previous accepted decision; what appeared or changed since it is mandatory (C3). */
  readonly previous: DecisionRow | undefined;
}

function taskObservation(task: Task) {
  return {
    taskId: task.taskId,
    type: task.workflowType,
    status: task.status,
    coverage: task.coverage,
    failureCode: task.failureReason?.code ?? null,
    outcome: task.outcome?.answerOrDelta ?? null,
    warnings: task.outcome?.warnings ?? [],
  };
}

function countTasks(tasks: readonly Task[]): TaskCount[] {
  const counts = new Map<string, TaskCount>();
  for (const task of tasks) {
    const failureReason = task.failureReason?.code ?? null;
    const key = JSON.stringify([task.workflowType, task.status, failureReason]);
    const current = counts.get(key);
    counts.set(key, { type: task.workflowType, status: task.status, failureReason, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()];
}

/**
 * The controller input split as in C3: the plan revision, budget, admissible decisions, signals and what appeared or
 * changed since the previous step are mandatory — open tasks, tasks the previous step proposed, claim revisions written
 * after it; the other tasks are counted and the other claims become compressible lines.
 */
export function controllerMaterial(parts: DecisionInputParts): ControllerMaterial {
  const proposedByPrevious = new Set(parts.previous?.proposedTaskIds ?? []);
  const isNewTask = (task: Task) => !FINAL_STATUSES.has(task.status) || proposedByPrevious.has(task.taskId);
  const since = parts.previous?.createdAt;
  const isNewClaim = (claim: LatestClaimRow) => since === undefined || claim.createdAt > since;
  const newClaims = parts.claims.filter(isNewClaim);
  const earlierClaims: ClaimLine[] = parts.claims
    .filter((claim) => !isNewClaim(claim))
    .map((claim) => ({ claimId: claim.claimId, status: claim.status, text: claim.text, revisedAt: claim.createdAt }));
  return {
    mandatory: {
      planRevision: { revision: parts.plan.revision, ...(parts.plan.plan as object) },
      budget: parts.budget,
      admissible: parts.admissible,
      signals: parts.signals.map(toInputSignal),
      observations: {
        tasks: parts.tasks.filter(isNewTask).map(taskObservation),
        claims: newClaims.map((claim) => ({
          claimId: claim.claimId,
          status: claim.status,
          text: claim.text,
          evidenceIds: claim.evidenceIds,
        })),
        stepsWithoutNovelty: parts.stepsWithoutNovelty,
      },
    },
    taskCounts: countTasks(parts.tasks.filter((task) => !isNewTask(task))),
    claims: earlierClaims,
  };
}
