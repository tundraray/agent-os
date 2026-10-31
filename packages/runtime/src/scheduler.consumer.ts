import {
  type EventEnvelope,
  type FailureReason,
  FailureReasonSchema,
  RuntimeEventTypeSchema,
  TaskEdgeKindSchema,
  type TaskStatus,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  researchTaskDependencies,
  researchTasks,
  researchTaskSubscribers,
} from '@agent-os/db';
import type { Clock } from './clock.js';
import type { EventConsumer } from './event-consumer.registry.js';
import { EventLog, RUNTIME_EVENT_SCHEMA_VERSION } from './event-log.js';
import type { RuntimeTx, TaskRow } from './guarded-transition.js';
import { TaskRepository } from './task.repository.js';

const { queued, waiting, succeeded, failed, cancelled } = TaskStatusSchema.enum;
const { TaskSucceeded, TaskFailed, TaskCancelled, TaskQueued } =
  RuntimeEventTypeSchema.enum;
const { depends_on, waits_for } = TaskEdgeKindSchema.enum;
/** Statuses that end a task; a waiter wakes when every awaited task is in one of them. */
const FINISHED: readonly TaskStatus[] = [succeeded, failed, cancelled];

const WaitConditionSchema = z.object({ waitFor: z.array(z.uuid()).min(1) });

/** The task whose end the event reports, as the cascade reads it. */
type EndedTask = Pick<TaskRow, 'taskId' | 'status' | 'failureReason'>;
/** A dependent of the ended task, as the cascade reads it. */
type Dependent = Pick<
  TaskRow,
  'taskId' | 'attempt' | 'attemptToolCalls' | 'attemptRetries'
>;

/**
 * `dependency_failed` of a dependent cancelled by the cascade (AC-04.2): the direct cause is the
 * ended task, the root cause is carried over when that task was itself cancelled by a cascade.
 */
function cascadeFailure(ended: EndedTask, dependent: Dependent): FailureReason {
  const upstream = FailureReasonSchema.safeParse(ended.failureReason);
  const rootCauseTaskId =
    upstream.success && upstream.data.class === 'dependency_failed'
      ? upstream.data.rootCauseTaskId
      : undefined;
  return {
    class: 'dependency_failed',
    code: `dependency_${ended.status}`,
    message: `Dependency ${ended.taskId} ended ${ended.status}`,
    cause: null,
    attempt: dependent.attempt,
    toolCalls: dependent.attemptToolCalls,
    retries: dependent.attemptRetries,
    dependencyTaskId: ended.taskId,
    rootCauseTaskId: rootCauseTaskId ?? ended.taskId,
  };
}

/**
 * The runtime's consumer `runtime.scheduler` of `TaskSucceeded`, `TaskFailed` and `TaskCancelled`
 * (Contract Definitions, EventEnvelope). Runs in the relay's delivery transaction, under the
 * investigation lock, in a savepoint: a failed or cancelled task cancels its `queued` dependents
 * with `dependency_failed` (each with its own `TaskCancelled`, whose delivery carries the cascade
 * one level further); a `waiting` task whose awaited tasks have all finished returns to `queued`
 * (`TaskQueued (woken)`); the task's subscribers get the event's id as `notified_event_id`. Every
 * write is guarded, so a second pass on the same event changes nothing.
 */
export class SchedulerConsumer implements EventConsumer {
  readonly name = 'runtime.scheduler';
  readonly eventTypes = [TaskSucceeded, TaskFailed, TaskCancelled];
  readonly schemaVersions = [RUNTIME_EVENT_SCHEMA_VERSION];

  constructor(
    private readonly clock: Clock,
    private readonly tasks: TaskRepository,
    private readonly events: EventLog,
  ) {}

  async handle(tx: RuntimeTx, event: EventEnvelope): Promise<void> {
    const { taskId } = event;
    if (taskId === null) {
      throw new Error(`${event.type} ${event.eventId} names no task`);
    }
    if (event.type !== TaskSucceeded) await this.cascade(tx, event, taskId);
    await this.wakeWaiters(tx, event, taskId);
    await this.notifySubscribers(tx, event, taskId);
  }

  private async cascade(
    tx: RuntimeTx,
    event: EventEnvelope,
    taskId: string,
  ): Promise<void> {
    const ended = await this.tasks.findTask(tx, taskId);
    if (!ended) return;
    const dependents = await tx
      .select({
        taskId: researchTasks.taskId,
        attempt: researchTasks.attempt,
        attemptToolCalls: researchTasks.attemptToolCalls,
        attemptRetries: researchTasks.attemptRetries,
      })
      .from(researchTaskDependencies)
      .innerJoin(
        researchTasks,
        eq(researchTasks.taskId, researchTaskDependencies.taskId),
      )
      .where(
        and(
          eq(researchTaskDependencies.dependsOnTaskId, taskId),
          eq(researchTaskDependencies.kind, depends_on),
          eq(researchTasks.status, queued),
        ),
      )
      .orderBy(asc(researchTasks.taskId));
    for (const dependent of dependents) {
      const failure = cascadeFailure(ended, dependent);
      const row = await this.tasks.transition(
        tx,
        { taskId: dependent.taskId, from: [queued] },
        {
          kind: 'set',
          status: cancelled,
          fields: { failureReason: failure, finishedAt: this.clock.now() },
        },
      );
      if (!row) continue;
      await this.events.append(tx, {
        type: TaskCancelled,
        investigationId: row.investigationId,
        taskId: row.taskId,
        causationId: event.eventId,
        stateRevision: row.stateVersion,
        payload: {
          failureClass: failure.class,
          dependencyTaskId: failure.dependencyTaskId ?? null,
          rootCauseTaskId: failure.rootCauseTaskId ?? null,
        },
      });
    }
  }

  /** `waiting` tasks with a `waits_for` edge to the task wake once all they wait for has finished. */
  private async wakeWaiters(
    tx: RuntimeTx,
    event: EventEnvelope,
    taskId: string,
  ): Promise<void> {
    const waiters = await tx
      .select({
        taskId: researchTasks.taskId,
        waitCondition: researchTasks.waitCondition,
      })
      .from(researchTaskDependencies)
      .innerJoin(
        researchTasks,
        eq(researchTasks.taskId, researchTaskDependencies.taskId),
      )
      .where(
        and(
          eq(researchTaskDependencies.dependsOnTaskId, taskId),
          eq(researchTaskDependencies.kind, waits_for),
          eq(researchTasks.status, waiting),
        ),
      )
      .orderBy(asc(researchTasks.taskId));
    for (const waiter of waiters) {
      const { waitFor } = WaitConditionSchema.parse(waiter.waitCondition);
      if (!(await this.allFinished(tx, waitFor))) continue;
      const row = await this.tasks.transition(
        tx,
        { taskId: waiter.taskId, from: [waiting] },
        { kind: 'set', status: queued },
      );
      if (!row) continue;
      await this.events.append(tx, {
        type: TaskQueued,
        investigationId: row.investigationId,
        taskId: row.taskId,
        causationId: event.eventId,
        stateRevision: row.stateVersion,
        payload: { reason: 'woken' },
      });
    }
  }

  private async allFinished(
    tx: RuntimeTx,
    taskIds: readonly string[],
  ): Promise<boolean> {
    const awaited = await tx
      .select({ status: researchTasks.status })
      .from(researchTasks)
      .where(inArray(researchTasks.taskId, [...taskIds]));
    return (
      awaited.length === new Set(taskIds).size &&
      awaited.every((task) =>
        FINISHED.includes(TaskStatusSchema.parse(task.status)),
      )
    );
  }

  /** Each subscriber is notified once: the first delivered end of the task. */
  private async notifySubscribers(
    tx: RuntimeTx,
    event: EventEnvelope,
    taskId: string,
  ): Promise<void> {
    await tx
      .update(researchTaskSubscribers)
      .set({ notifiedEventId: event.eventId })
      .where(
        and(
          eq(researchTaskSubscribers.taskId, taskId),
          isNull(researchTaskSubscribers.notifiedEventId),
        ),
      );
  }
}
