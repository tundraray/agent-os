import { randomUUID } from 'node:crypto';
import {
  CoverageSchema,
  FailureReasonSchema,
  type Investigation,
  type InvestigationSpec,
  InvestigationSpecSchema,
  InvestigationStatusSchema,
  RuntimeEventTypeSchema,
  type Task,
  TaskOutcomeSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Database, DRIZZLE } from '../database/database.module.js';
import {
  researchInvestigations,
  researchTasks,
  researchTaskSubscribers,
} from '../database/schema.js';
import type {
  ThreadDeletionStop,
  ThreadRef,
} from '../threads/thread-deletion-hooks.js';
import { ThreadsService } from '../threads/threads.service.js';
import { CLOCK, type Clock } from './clock.js';
import { CrashPoints } from './crash-points.js';
import {
  CANCEL_REQUESTED_FAILURE,
  CANCELLED_EVENT_PAYLOAD,
} from './dispatcher.js';
import { EventLog } from './event-log.js';
import type { RuntimeTx, TaskRow } from './guarded-transition.js';
import { RunningTaskRegistry } from './running-task.registry.js';
import { type InvestigationRow, TaskRepository } from './task.repository.js';

const { queued, running, waiting, cancelled } = TaskStatusSchema.enum;
const { active, deleting } = InvestigationStatusSchema.enum;
const { InvestigationCancelled, TaskCancelled } = RuntimeEventTypeSchema.enum;

/** No investigation with this id for the owner. */
class InvestigationNotFoundError extends Error {
  override readonly name = 'InvestigationNotFoundError';
  readonly code = 'investigation_not_found';
}

/** What the cancel transaction changed. */
interface CancelSummary {
  cancelledTasks: number;
  cancelRequestedTasks: number;
}

/**
 * `research_tasks.outcome` as stored: the `HandlerResult` fields of `Task.outcome` and the
 * result's `coverage` (the read model returns them as `outcome` and `coverage`).
 */
const StoredOutcomeSchema = TaskOutcomeSchema.extend({
  coverage: CoverageSchema.nullable(),
});

/**
 * Fails fast on an empty owner id, as `assertUserId` of the threads API: an empty filter would
 * read every user's investigations. A plain Error — a server defect, answered with 500.
 */
const assertResourceId = (resourceId: string): void => {
  if (!resourceId) {
    throw new Error('InvestigationService: resourceId must not be empty');
  }
};

function toInvestigation(row: InvestigationRow): Investigation {
  return {
    investigationId: row.investigationId,
    resourceId: row.resourceId,
    threadId: row.threadId,
    query: row.query,
    budget: { maxTasks: row.maxTasks, maxToolCalls: row.maxToolCalls },
    status: InvestigationStatusSchema.parse(row.status),
    createdAt: row.createdAt.toISOString(),
  };
}

function toTask(row: TaskRow, subscribers: string[]): Task {
  const stored =
    row.outcome === null ? null : StoredOutcomeSchema.parse(row.outcome);
  return {
    taskId: row.taskId,
    workflowType: row.workflowType,
    workflowVersion: row.workflowVersion,
    status: TaskStatusSchema.parse(row.status),
    dedupKey: row.dedupKey,
    outputRefs: row.outputRefs,
    outcome: stored && {
      answerOrDelta: stored.answerOrDelta,
      missingEvidence: stored.missingEvidence,
      warnings: stored.warnings,
    },
    coverage: stored?.coverage ?? null,
    failureReason: FailureReasonSchema.nullable().parse(row.failureReason),
    attempt: row.attempt,
    toolCallsUsed: row.toolCallsUsed,
    retriesUsed: row.retriesUsed,
    subscribers,
  };
}

/** Resolves when `released` does or `window` aborts, whichever is first; never rejects. */
function untilSettled(
  released: Promise<unknown>,
  window: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener('abort', done);
      resolve();
    };
    if (window.aborted) return resolve();
    window.addEventListener('abort', done, { once: true });
    released.then(done, done);
  });
}

/** Items grouped by a key, each group in the order of `items`. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Investigations of a thread: creation behind the thread's ownership check, and the owner's
 * read model. Every read filters by `resource_id`.
 */
@Injectable()
export class InvestigationService {
  private readonly logger = new Logger(InvestigationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly threads: ThreadsService,
    private readonly events: EventLog,
    private readonly tasks: TaskRepository,
    private readonly crashPoints: CrashPoints,
    private readonly running: RunningTaskRegistry,
  ) {}

  /**
   * Cancels an `active` investigation of the owner (Flow 4) in one transaction, in the lock order:
   * the investigation FOR NO KEY UPDATE, then its unfinished tasks by `task_id`. The investigation
   * becomes `cancelled` (`InvestigationCancelled`), `queued` and `waiting` tasks `cancelled` with
   * class `cancelled` (`TaskCancelled` each), `running` tasks get `cancel_requested_at`: from the
   * commit on their reservations are refused, and their outcome is `cancelled` — written at once
   * for attempts of this process (aborted with `cancelled`), after the heartbeat for another
   * instance's, or by the reaper once the lease of a gone worker expires. A task
   * that wrote `succeeded` before keeps it. A repeated cancel changes nothing. No handler is called.
   */
  async cancel(investigationId: string, resourceId: string): Promise<void> {
    assertResourceId(resourceId);
    const summary = await this.db.transaction((tx) =>
      this.cancelInTx(tx, investigationId, resourceId),
    );
    if (!summary) return;
    this.crashPoints.hit('cancel.after-commit');
    // The abort is synchronous; its outcome writes do not wait for the handlers, and the cancel
    // does not wait for them either (an attempt stopping on shutdown may be waiting for it).
    void this.running.abortInvestigation(investigationId, 'cancelled');
    this.logger.log(
      `investigation cancelled investigationId=${investigationId} cancelledTasks=${summary.cancelledTasks} cancelRequestedTasks=${summary.cancelRequestedTasks}`,
    );
  }

  /** The cancel transaction; `undefined` when the investigation is no longer `active`. */
  private async cancelInTx(
    tx: RuntimeTx,
    investigationId: string,
    resourceId: string,
  ): Promise<CancelSummary | undefined> {
    const investigation = await this.tasks.lockInvestigation(
      tx,
      investigationId,
    );
    if (investigation?.resourceId !== resourceId) {
      throw new InvestigationNotFoundError(
        `Investigation ${investigationId} not found`,
      );
    }
    if (investigation.status !== active) return undefined;

    const [row] = await tx
      .update(researchInvestigations)
      .set({
        status: InvestigationStatusSchema.enum.cancelled,
        revision: sql`${researchInvestigations.revision} + 1`,
        updatedAt: this.clock.now(),
      })
      .where(eq(researchInvestigations.investigationId, investigationId))
      .returning();
    const cancelEvent = await this.events.append(tx, {
      type: InvestigationCancelled,
      investigationId,
      taskId: null,
      causationId: null,
      stateRevision: row.revision,
      payload: {},
    });

    // Admission takes the investigation lock too: no task is added meanwhile.
    const unfinished = await tx
      .select({ taskId: researchTasks.taskId })
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.investigationId, investigationId),
          inArray(researchTasks.status, [queued, running, waiting]),
        ),
      );
    const locked = await this.tasks.lockTasks(
      tx,
      unfinished.map((task) => task.taskId),
    );
    const summary: CancelSummary = {
      cancelledTasks: 0,
      cancelRequestedTasks: 0,
    };
    for (const task of locked) {
      if (task.status === running) {
        if (await this.requestCancel(tx, task))
          summary.cancelRequestedTasks += 1;
      } else if (await this.cancelTask(tx, task, cancelEvent.eventId)) {
        summary.cancelledTasks += 1;
      }
    }
    return summary;
  }

  /** `cancel_requested_at` on the running attempt; its own guarded write ends it. */
  private async requestCancel(tx: RuntimeTx, task: TaskRow): Promise<boolean> {
    const row = await this.tasks.transition(
      tx,
      { taskId: task.taskId, from: [running], attempt: task.attempt },
      { kind: 'set', fields: { cancelRequestedAt: this.clock.now() } },
    );
    return row !== undefined;
  }

  /** A `queued` or `waiting` task ends `cancelled`, caused by the investigation's cancel. */
  private async cancelTask(
    tx: RuntimeTx,
    task: TaskRow,
    causationId: string,
  ): Promise<boolean> {
    const row = await this.tasks.transition(
      tx,
      { taskId: task.taskId, from: [queued, waiting] },
      {
        kind: 'set',
        status: cancelled,
        fields: {
          failureReason: {
            ...CANCEL_REQUESTED_FAILURE,
            attempt: task.attempt,
            toolCalls: task.attemptToolCalls,
            retries: task.attemptRetries,
          },
          finishedAt: this.clock.now(),
        },
      },
    );
    if (!row) return false;
    await this.events.append(tx, {
      type: TaskCancelled,
      investigationId: row.investigationId,
      taskId: row.taskId,
      causationId,
      stateRevision: row.stateVersion,
      payload: CANCELLED_EVENT_PAYLOAD,
    });
    return true;
  }

  /**
   * `ThreadDeletionHook.stop` (Flow 5): in one transaction, in the lock order, the thread's
   * investigations become `deleting` (no claim or admission from the commit on) and their
   * unfinished tasks get `cancel_requested_at` (reservations refused); then the attempts of this
   * process are aborted. Returns right after; `settled` resolves when those attempts have made
   * their last write or `window` aborts. A repeat changes nothing. No handler is called.
   */
  async stopThread(
    ref: ThreadRef,
    window: AbortSignal,
  ): Promise<ThreadDeletionStop> {
    assertResourceId(ref.resourceId);
    const investigationIds = await this.db.transaction((tx) =>
      this.stopInTx(tx, ref),
    );
    const released = investigationIds.map((investigationId) =>
      this.running.abortInvestigation(investigationId, 'cancelled'),
    );
    if (investigationIds.length > 0) {
      this.logger.log(
        `thread investigations stopped threadId=${ref.threadId} investigations=${investigationIds.length}`,
      );
    }
    return { settled: untilSettled(Promise.all(released), window) };
  }

  /** The stop transaction; the ids of the thread's investigations it locked. */
  private async stopInTx(tx: RuntimeTx, ref: ThreadRef): Promise<string[]> {
    const investigations = await this.lockThreadInvestigations(tx, ref);
    if (investigations.length === 0) return [];
    const ids = investigations.map((row) => row.investigationId);
    const toDeleting = investigations
      .filter((row) => row.status !== deleting)
      .map((row) => row.investigationId);
    if (toDeleting.length > 0) {
      await tx
        .update(researchInvestigations)
        .set({
          status: deleting,
          revision: sql`${researchInvestigations.revision} + 1`,
          updatedAt: this.clock.now(),
        })
        .where(inArray(researchInvestigations.investigationId, toDeleting));
    }
    const unfinished = await tx
      .select({ taskId: researchTasks.taskId })
      .from(researchTasks)
      .where(
        and(
          inArray(researchTasks.investigationId, ids),
          inArray(researchTasks.status, [queued, running, waiting]),
          isNull(researchTasks.cancelRequestedAt),
        ),
      );
    const locked = await this.tasks.lockTasks(
      tx,
      unfinished.map((task) => task.taskId),
    );
    for (const task of locked) {
      await this.tasks.transition(
        tx,
        {
          taskId: task.taskId,
          from: [queued, running, waiting],
          attempt: task.attempt,
          where: isNull(researchTasks.cancelRequestedAt),
        },
        { kind: 'set', fields: { cancelRequestedAt: this.clock.now() } },
      );
    }
    return ids;
  }

  /**
   * `ThreadDeletionHook.purge` (Flow 5), called under the thread's lock: in one transaction, in
   * the lock order, the thread's investigations FOR NO KEY UPDATE, their tasks FOR UPDATE by
   * `task_id`, then DELETE of the investigations — every other research row goes by the cascade
   * from `research_investigations`. Includes investigations created after `stop`. Their local
   * attempts are aborted without waiting; their late writes find no row. No handler is called.
   */
  async purgeThread(ref: ThreadRef): Promise<void> {
    assertResourceId(ref.resourceId);
    const investigationIds = await this.db.transaction(async (tx) => {
      const investigations = await this.lockThreadInvestigations(tx, ref);
      if (investigations.length === 0) return [];
      const ids = investigations.map((row) => row.investigationId);
      const tasks = await tx
        .select({ taskId: researchTasks.taskId })
        .from(researchTasks)
        .where(inArray(researchTasks.investigationId, ids));
      await this.tasks.lockTasks(
        tx,
        tasks.map((task) => task.taskId),
      );
      await tx
        .delete(researchInvestigations)
        .where(inArray(researchInvestigations.investigationId, ids));
      return ids;
    });
    for (const investigationId of investigationIds) {
      void this.running.abortInvestigation(investigationId, 'cancelled');
    }
    if (investigationIds.length > 0) {
      this.logger.log(
        `thread investigations purged threadId=${ref.threadId} investigations=${investigationIds.length}`,
      );
    }
  }

  /** The owner's investigations of the thread, locked FOR NO KEY UPDATE in `investigation_id` order. */
  private lockThreadInvestigations(
    tx: RuntimeTx,
    ref: ThreadRef,
  ): Promise<InvestigationRow[]> {
    return tx
      .select()
      .from(researchInvestigations)
      .where(
        and(
          eq(researchInvestigations.resourceId, ref.resourceId),
          eq(researchInvestigations.threadId, ref.threadId),
        ),
      )
      .orderBy(asc(researchInvestigations.investigationId))
      .for('no key update');
  }

  /**
   * Creates an `active` investigation of an own thread with its `InvestigationCreated` event.
   * The insert runs under the thread's lock after the ownership check (`withOwnedThread`):
   * a missing or foreign thread is the threads API's 404 and nothing is written.
   */
  async create(spec: InvestigationSpec): Promise<Investigation> {
    assertResourceId(spec.resourceId);
    const valid = InvestigationSpecSchema.parse(spec);
    return this.threads.withOwnedThread(valid.threadId, valid.resourceId, () =>
      this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(researchInvestigations)
          .values({
            investigationId: randomUUID(),
            resourceId: valid.resourceId,
            threadId: valid.threadId,
            query: valid.query,
            maxTasks: valid.budget.maxTasks,
            maxToolCalls: valid.budget.maxToolCalls,
          })
          .returning();
        await this.events.append(tx, {
          type: RuntimeEventTypeSchema.enum.InvestigationCreated,
          investigationId: row.investigationId,
          taskId: null,
          causationId: null,
          stateRevision: row.revision,
          payload: {},
        });
        return toInvestigation(row);
      }),
    );
  }

  /**
   * The owner's investigations of the thread with their tasks (AC-01.1). Ordered by the full
   * sort key: investigations by (`created_at`, `investigation_id`), tasks by (`created_at`,
   * `task_id`), subscribers by key — rows created in one transaction share `created_at`.
   */
  async listForThread(
    resourceId: string,
    threadId: string,
  ): Promise<Investigation[]> {
    assertResourceId(resourceId);
    const investigations = await this.db
      .select()
      .from(researchInvestigations)
      .where(
        and(
          eq(researchInvestigations.resourceId, resourceId),
          eq(researchInvestigations.threadId, threadId),
        ),
      )
      .orderBy(
        asc(researchInvestigations.createdAt),
        asc(researchInvestigations.investigationId),
      );
    if (investigations.length === 0) return [];

    const tasks = await this.db
      .select()
      .from(researchTasks)
      .where(
        inArray(
          researchTasks.investigationId,
          investigations.map((row) => row.investigationId),
        ),
      )
      .orderBy(asc(researchTasks.createdAt), asc(researchTasks.taskId));
    const subscribers =
      tasks.length === 0
        ? []
        : await this.db
            .select()
            .from(researchTaskSubscribers)
            .where(
              inArray(
                researchTaskSubscribers.taskId,
                tasks.map((row) => row.taskId),
              ),
            )
            .orderBy(
              asc(researchTaskSubscribers.taskId),
              asc(researchTaskSubscribers.subscriberKey),
            );

    const subscribersByTask = groupBy(subscribers, (row) => row.taskId);
    const tasksByInvestigation = groupBy(tasks, (row) => row.investigationId);
    return investigations.map((row) => ({
      ...toInvestigation(row),
      tasks: (tasksByInvestigation.get(row.investigationId) ?? []).map((task) =>
        toTask(
          task,
          (subscribersByTask.get(task.taskId) ?? []).map(
            (subscriber) => subscriber.subscriberKey,
          ),
        ),
      ),
    }));
  }
}
