import { randomUUID } from 'node:crypto';
import {
  type FailureReason,
  FailureReasonSchema,
  InvestigationStatusSchema,
  type ProposeResult,
  RequesterKeySchema,
  RuntimeEventTypeSchema,
  TaskEdgeKindSchema,
  type TaskSpec,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Database, DRIZZLE } from '../database/database.module.js';
import {
  researchInvestigations,
  researchTaskDependencies,
  researchTasks,
} from '../database/schema.js';
import { CLOCK, type Clock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import { computeDedupKey } from './dedup-key.js';
import { EventLog } from './event-log.js';
import type { RuntimeTx, TaskRow } from './guarded-transition.js';
import {
  HandlerRegistry,
  type RegisterWaitResult,
} from './handler.registry.js';
import { checkTaskSpec, rejection } from './task-spec.js';
import {
  type InvestigationRow,
  type NewTaskRow,
  TaskRepository,
} from './task.repository.js';

const { queued, failed, cancelled } = TaskStatusSchema.enum;
const { waits_for } = TaskEdgeKindSchema.enum;

/** A dependency of a proposed task as read at admission. */
type DependencyRow = Pick<TaskRow, 'taskId' | 'status' | 'failureReason'>;

/** The edge set whose acyclicity is checked: `taskId` gains edges to every target. */
interface EdgeCandidate {
  investigationId: string;
  taskId: string;
  targetIds: readonly string[];
}

/**
 * The tasks of the cycle that the new edges `taskId → targetIds` would close, starting at
 * `taskId`; `undefined` when the graph stays acyclic. One recursive CTE over the edges of both
 * kinds (`depends_on`, `waits_for`) of the investigation; call under the investigation lock,
 * which serialises every edge write (KD-3).
 */
async function findEdgeCycle(
  tx: RuntimeTx,
  edge: EdgeCandidate,
): Promise<string[] | undefined> {
  if (edge.targetIds.length === 0) return undefined;
  const targets = sql.join(
    edge.targetIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await tx.execute<{ path: string[] }>(sql`
    with recursive reach(node, path) as (
      select target, array[target]
      from unnest(array[${targets}]) as target
      union all
      select dependency.depends_on_task_id, reach.path || dependency.depends_on_task_id
      from reach
      join ${researchTaskDependencies} as dependency on dependency.task_id = reach.node
      where dependency.investigation_id = ${edge.investigationId}::uuid
        and not dependency.depends_on_task_id = any(reach.path)
    )
    select path::text[] as path from reach where node = ${edge.taskId}::uuid limit 1
  `);
  const [found] = rows;
  // `path` runs from a target to `taskId`; the cycle starts at `taskId`.
  return found ? [edge.taskId, ...found.path.slice(0, -1)] : undefined;
}

/** `wait_cycle` naming the tasks of the cycle, for edges of either kind (AC-07.1–AC-07.3). */
const cycleRejection = (cycle: readonly string[]) =>
  rejection('wait_cycle', { cycle });

/** The exhausted limit of the investigation, or `undefined` when the task fits its budget. */
function exhaustedLimit(
  investigation: InvestigationRow,
  maxToolCalls: number,
): Record<string, unknown> | undefined {
  if (investigation.tasksReserved >= investigation.maxTasks) {
    return {
      limit: 'tasks',
      max: investigation.maxTasks,
      reserved: investigation.tasksReserved,
    };
  }
  if (
    investigation.toolCallsReserved + maxToolCalls >
    investigation.maxToolCalls
  ) {
    return {
      limit: 'tool_calls',
      max: investigation.maxToolCalls,
      reserved: investigation.toolCallsReserved,
      requested: maxToolCalls,
    };
  }
  return undefined;
}

/**
 * `dependency_failed` of a task admitted after its dependency already ended `failed` or
 * `cancelled` (AC-RT-6). The root cause is carried over from a dependency that was itself
 * cancelled by a cascade.
 */
function dependencyFailure(dependency: DependencyRow): FailureReason {
  const upstream = FailureReasonSchema.safeParse(dependency.failureReason);
  const rootCauseTaskId =
    upstream.success && upstream.data.class === 'dependency_failed'
      ? upstream.data.rootCauseTaskId
      : undefined;
  return {
    class: 'dependency_failed',
    code: `dependency_${dependency.status}`,
    message: `Dependency ${dependency.taskId} ended ${dependency.status} before admission`,
    cause: null,
    attempt: 0,
    toolCalls: 0,
    retries: 0,
    dependencyTaskId: dependency.taskId,
    rootCauseTaskId: rootCauseTaskId ?? dependency.taskId,
  };
}

/**
 * Admission of tasks (Flow 1). Validation that needs no database runs first; then, under the
 * investigation lock (FOR NO KEY UPDATE, before any task is read or written — KD-3): the live
 * task of the dedup key, dependencies, budget, edges with the cycle check, the task, its
 * subscriber, the reservation and the event — one transaction. A refusal is a value and writes
 * nothing; a database error is an exception and rolls everything back.
 */
@Injectable()
export class TaskScheduler {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly handlers: HandlerRegistry,
    private readonly tasks: TaskRepository,
    private readonly events: EventLog,
    private readonly crashPoints: CrashPoints,
  ) {}

  async propose(spec: TaskSpec, requesterKey: string): Promise<ProposeResult> {
    const requester = RequesterKeySchema.safeParse(requesterKey);
    if (!requester.success) {
      return rejection('invalid_spec', {
        path: 'requesterKey',
        message: requester.error.issues[0].message,
      });
    }
    const checked = checkTaskSpec(spec, this.handlers);
    if (!checked.ok) return checked.rejection;

    const result = await this.db.transaction((tx) =>
      this.admit(tx, checked.spec, requester.data),
    );
    if (result.outcome !== 'rejected') {
      this.crashPoints.hit('admission.after-commit');
    }
    return result;
  }

  /**
   * Admission of a checked spec (`checkTaskSpec`) inside `tx`; takes the investigation lock
   * first. Public for the Dispatcher, which admits `proposedTasks` in the outcome's transaction.
   */
  async admit(
    tx: RuntimeTx,
    spec: TaskSpec,
    requesterKey: string,
  ): Promise<ProposeResult> {
    const investigation = await this.tasks.lockInvestigation(
      tx,
      spec.investigationId,
    );
    if (investigation?.status !== InvestigationStatusSchema.enum.active) {
      return rejection('investigation_inactive', {
        status: investigation?.status ?? 'missing',
      });
    }

    const dependsOn = [...new Set(spec.dependsOn)];
    const dependencies = await this.readDependencies(
      tx,
      spec.investigationId,
      dependsOn,
    );
    const unknown = dependsOn.filter((id) => !dependencies.has(id));
    if (unknown.length > 0) {
      return rejection('unknown_dependency', { taskIds: unknown });
    }

    const dedupKey = computeDedupKey(spec);
    const live = await this.tasks.findLiveTask(
      tx,
      spec.investigationId,
      dedupKey,
    );
    if (live) return this.subscribe(tx, live, dependsOn, requesterKey);

    const exhausted = exhaustedLimit(investigation, spec.budget.maxToolCalls);
    if (exhausted) return rejection('budget_exhausted', exhausted);

    const taskId = randomUUID();
    const cycle = await findEdgeCycle(tx, {
      investigationId: spec.investigationId,
      taskId,
      targetIds: dependsOn,
    });
    if (cycle) return cycleRejection(cycle);

    const endedDependency = dependsOn
      .map((id) => dependencies.get(id))
      .find((row) => row?.status === failed || row?.status === cancelled);
    const row = await this.tasks.insertTask(
      tx,
      this.newTaskRow(spec, { taskId, dedupKey, endedDependency }),
    );
    if (!row) {
      // A parallel admission took the key first (spike A1): subscribe to its task instead.
      const holder = await this.tasks.findLiveTask(
        tx,
        spec.investigationId,
        dedupKey,
      );
      if (!holder) {
        throw new Error(
          `Dedup key of investigation ${spec.investigationId} conflicted without a live task`,
        );
      }
      return this.subscribe(tx, holder, dependsOn, requesterKey);
    }

    await this.tasks.insertEdges(
      tx,
      dependsOn.map((dependsOnTaskId) => ({
        investigationId: spec.investigationId,
        taskId,
        dependsOnTaskId,
        kind: 'depends_on' as const,
      })),
    );
    await this.tasks.addSubscriber(tx, taskId, requesterKey);
    await this.reserve(tx, spec);
    await this.appendAdmissionEvent(tx, row);
    return {
      outcome: 'created',
      taskId,
      status: TaskStatusSchema.parse(row.status),
    };
  }

  /**
   * Records `waits_for` edges of an existing task (`TaskContext.registerWait`) after the same
   * acyclicity check as admission's `depends_on` edges. Call under the investigation lock, which
   * serialises every edge write: without it two crossed edges both pass the check (spike A2).
   * A refusal writes nothing; an edge already recorded is not written again.
   */
  async addWaitEdges(
    tx: RuntimeTx,
    edge: EdgeCandidate,
  ): Promise<RegisterWaitResult> {
    const targetIds = [...new Set(edge.targetIds)];
    if (targetIds.includes(edge.taskId)) {
      return rejection('self_dependency', { taskId: edge.taskId });
    }
    const known = await this.readDependencies(
      tx,
      edge.investigationId,
      targetIds,
    );
    const unknown = targetIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return rejection('unknown_dependency', { taskIds: unknown });
    }
    const cycle = await findEdgeCycle(tx, { ...edge, targetIds });
    if (cycle) return cycleRejection(cycle);

    const recorded = await this.waitTargetsOf(tx, edge.taskId);
    await this.tasks.insertEdges(
      tx,
      targetIds
        .filter((id) => !recorded.has(id))
        .map((dependsOnTaskId) => ({
          investigationId: edge.investigationId,
          taskId: edge.taskId,
          dependsOnTaskId,
          kind: waits_for,
        })),
    );
    return { outcome: 'ok' };
  }

  /** Targets of the task's recorded `waits_for` edges. */
  async waitTargetsOf(tx: RuntimeTx, taskId: string): Promise<Set<string>> {
    const rows = await tx
      .select({ targetId: researchTaskDependencies.dependsOnTaskId })
      .from(researchTaskDependencies)
      .where(
        and(
          eq(researchTaskDependencies.taskId, taskId),
          eq(researchTaskDependencies.kind, waits_for),
        ),
      );
    return new Set(rows.map((row) => row.targetId));
  }

  /** The proposing side becomes a subscriber of the live task; the budget is not spent. */
  private async subscribe(
    tx: RuntimeTx,
    live: TaskRow,
    dependsOn: readonly string[],
    requesterKey: string,
  ): Promise<ProposeResult> {
    if (dependsOn.includes(live.taskId)) {
      return rejection('self_dependency', { taskId: live.taskId });
    }
    await this.tasks.addSubscriber(tx, live.taskId, requesterKey);
    return {
      outcome: 'subscribed',
      taskId: live.taskId,
      status: TaskStatusSchema.parse(live.status),
    };
  }

  /** Dependencies that belong to the investigation; a plain read under its lock. */
  private async readDependencies(
    tx: RuntimeTx,
    investigationId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, DependencyRow>> {
    if (taskIds.length === 0) return new Map();
    const rows = await tx
      .select({
        taskId: researchTasks.taskId,
        status: researchTasks.status,
        failureReason: researchTasks.failureReason,
      })
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.investigationId, investigationId),
          inArray(researchTasks.taskId, [...taskIds]),
        ),
      );
    return new Map(rows.map((row) => [row.taskId, row]));
  }

  private newTaskRow(
    spec: TaskSpec,
    task: {
      taskId: string;
      dedupKey: string;
      endedDependency: DependencyRow | undefined;
    },
  ): NewTaskRow {
    const contract: NewTaskRow = {
      taskId: task.taskId,
      investigationId: spec.investigationId,
      workflowType: spec.workflowType,
      workflowVersion: spec.workflowVersion,
      input: spec.input,
      inputRefs: spec.inputRefs,
      expectedOutput: spec.expectedOutput,
      dedupKey: task.dedupKey,
      maxToolCalls: spec.budget.maxToolCalls,
      maxRetries: spec.budget.maxRetries,
      deadlineMs: spec.budget.deadlineMs,
      maxTokens: spec.budget.maxTokens,
    };
    if (!task.endedDependency) return { ...contract, status: queued };
    return {
      ...contract,
      status: cancelled,
      failureReason: dependencyFailure(task.endedDependency),
      finishedAt: this.clock.now(),
    };
  }

  /** One task and its whole tool-call limit come off the investigation's budget. */
  private async reserve(tx: RuntimeTx, spec: TaskSpec): Promise<void> {
    await tx
      .update(researchInvestigations)
      .set({
        tasksReserved: sql`${researchInvestigations.tasksReserved} + 1`,
        toolCallsReserved: sql`${researchInvestigations.toolCallsReserved} + ${spec.budget.maxToolCalls}`,
        revision: sql`${researchInvestigations.revision} + 1`,
        updatedAt: this.clock.now(),
      })
      .where(eq(researchInvestigations.investigationId, spec.investigationId));
  }

  /** `TaskQueued (admitted)`, or `TaskCancelled` for a task admitted after a failed dependency. */
  private async appendAdmissionEvent(
    tx: RuntimeTx,
    row: TaskRow,
  ): Promise<void> {
    const failure = FailureReasonSchema.nullable().parse(row.failureReason);
    await this.events.append(tx, {
      type: failure
        ? RuntimeEventTypeSchema.enum.TaskCancelled
        : RuntimeEventTypeSchema.enum.TaskQueued,
      investigationId: row.investigationId,
      taskId: row.taskId,
      causationId: null,
      stateRevision: row.stateVersion,
      payload: failure
        ? {
            failureClass: failure.class,
            dependencyTaskId: failure.dependencyTaskId ?? null,
            rootCauseTaskId: failure.rootCauseTaskId ?? null,
          }
        : { reason: 'admitted' },
    });
  }
}
