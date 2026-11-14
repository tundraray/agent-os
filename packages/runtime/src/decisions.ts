import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  type DecisionStatus,
  DecisionStatusSchema,
  RuntimeEventTypeSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type Database, runtimeDecisions, runtimeTasks } from '@agent-os/db';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { RuntimeError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { TaskRow } from './guarded-transition.js';
import { retryingTransaction, type RuntimeTx } from './runtime-tx.js';
import type { TaskRepository } from './task.repository.js';

export type DecisionRow = typeof runtimeDecisions.$inferSelect;

/** A request of a tree, in any status, as `listTree` returns it. */
export interface TreeDecision {
  readonly decisionId: string;
  readonly taskId: string;
  readonly rootId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: DecisionStatus;
  /** The employee's resolution; null until `resolved`. */
  readonly resolution: unknown;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/** What `resolve` did: wrote the resolution, or found the request no longer open. */
export type ResolveOutcome = 'resolved' | 'already_resolved';

/** What an `await_decision` step asks. */
export interface DecisionRequest {
  kind: string;
  payload: unknown;
}

export interface DecisionsDeps {
  db: Database;
  tasks: TaskRepository;
  events: EventLog;
  logger: Logger;
}

const { open, resolved } = DecisionStatusSchema.enum;
const { queued, waiting } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/**
 * Decision requests (design-runtime.md, Запросы решений; KD-2, Invariant 3): a step opens one with
 * `await_decision`, the employee resolves it once, and the resolution is handed to exactly one
 * committed step — the one whose commit sets `delivered_step`. Lock order: the task before its
 * request, as in a step's commit and in a stop.
 */
export class Decisions {
  constructor(private readonly deps: DecisionsDeps) {}

  /**
   * Opens the request of an `await_decision` step with `decision.requested`, in the step's commit
   * transaction under the task's lock. The caller puts the task in `waiting` (`decision`).
   */
  async open(tx: RuntimeTx, task: TaskRow, request: DecisionRequest): Promise<DecisionRow> {
    const [row] = await tx
      .insert(runtimeDecisions)
      .values({
        decisionId: randomUUID(),
        taskId: task.taskId,
        rootId: task.rootId,
        ownerId: task.ownerId,
        kind: request.kind,
        payload: request.payload ?? null,
        status: open,
      })
      .returning();
    await this.deps.events.append(tx, {
      type: EVENT['decision.requested'],
      task,
      payload: { decisionId: row.decisionId, kind: row.kind },
    });
    return row;
  }

  /** The task's resolved request that no committed step has received yet; read by the claim. */
  async loadUndelivered(tx: RuntimeTx, taskId: string): Promise<DecisionRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeDecisions)
      .where(
        and(
          eq(runtimeDecisions.taskId, taskId),
          eq(runtimeDecisions.status, resolved),
          isNull(runtimeDecisions.deliveredStep),
        ),
      )
      .orderBy(desc(runtimeDecisions.resolvedAt))
      .limit(1);
    return row;
  }

  /** Hands the request to step `stepNo`, in that step's commit transaction. */
  async markDelivered(tx: RuntimeTx, decisionId: string, stepNo: number): Promise<void> {
    await tx
      .update(runtimeDecisions)
      .set({ deliveredStep: stepNo })
      .where(
        and(
          eq(runtimeDecisions.decisionId, decisionId),
          isNull(runtimeDecisions.deliveredStep),
        ),
      );
  }

  /**
   * Writes the resolution once and queues the waiting task, with `decision.resolved` and
   * `task.queued`. A request that is `resolved` or `cancelled` (a stop closed it) gives
   * `already_resolved` and changes nothing. Throws `DECISION_NOT_FOUND` for a missing or another
   * owner's request.
   */
  async resolve(
    decisionId: string,
    ownerId: string,
    resolution: unknown,
  ): Promise<ResolveOutcome> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { decisionId, ownerId };
    try {
      const outcome = await retryingTransaction(db, logger, 'decisions.resolve', (tx) =>
        this.resolveIn(tx, decisionId, ownerId, resolution),
      );
      logger.info('decision resolve answered', {
        ...fields,
        taskId: outcome.taskId,
        rootId: outcome.rootId,
        outcome: outcome.outcome,
        durationMs: Date.now() - startedAt,
      });
      return outcome.outcome;
    } catch (error) {
      logger.warn('decision not resolved', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * All requests of the owner's tree in any status, in creation order; `[]` for another owner's
   * or no tree.
   */
  async listTree(rootId: string, ownerId: string): Promise<TreeDecision[]> {
    const rows = await this.deps.db
      .select({
        decisionId: runtimeDecisions.decisionId,
        taskId: runtimeDecisions.taskId,
        rootId: runtimeDecisions.rootId,
        kind: runtimeDecisions.kind,
        payload: runtimeDecisions.payload,
        status: runtimeDecisions.status,
        resolution: runtimeDecisions.resolution,
        createdAt: runtimeDecisions.createdAt,
        resolvedAt: runtimeDecisions.resolvedAt,
      })
      .from(runtimeDecisions)
      .where(and(eq(runtimeDecisions.rootId, rootId), eq(runtimeDecisions.ownerId, ownerId)))
      .orderBy(asc(runtimeDecisions.createdAt), asc(runtimeDecisions.decisionId));
    return rows.map((row) => ({ ...row, status: DecisionStatusSchema.parse(row.status) }));
  }

  private async resolveIn(
    tx: RuntimeTx,
    decisionId: string,
    ownerId: string,
    resolution: unknown,
  ): Promise<{ outcome: ResolveOutcome; taskId: string; rootId: string }> {
    const { tasks, events } = this.deps;
    const [found] = await tx
      .select({ taskId: runtimeDecisions.taskId, ownerId: runtimeDecisions.ownerId })
      .from(runtimeDecisions)
      .where(eq(runtimeDecisions.decisionId, decisionId));
    if (found?.ownerId !== ownerId) {
      throw new RuntimeError('DECISION_NOT_FOUND', `Decision ${decisionId} not found`);
    }
    // The task first, then its request: the order of a step's commit and of a stop.
    const task = await tasks.lock(tx, found.taskId);
    const [request] = await tx
      .select()
      .from(runtimeDecisions)
      .where(eq(runtimeDecisions.decisionId, decisionId))
      .for('update');
    if (!task || !request) {
      throw new RuntimeError('DECISION_NOT_FOUND', `Decision ${decisionId} not found`);
    }
    if (request.status !== open) {
      return { outcome: 'already_resolved', taskId: task.taskId, rootId: task.rootId };
    }

    await tx
      .update(runtimeDecisions)
      .set({ status: resolved, resolution: resolution ?? null, resolvedAt: sql`now()` })
      .where(eq(runtimeDecisions.decisionId, decisionId));
    // Invariant 3: an open request means its task waits for it.
    const woken = await tasks.transition(
      tx,
      {
        taskId: task.taskId,
        from: [waiting],
        where: eq(runtimeTasks.waitReason, WaitReasonSchema.enum.decision),
      },
      { kind: 'set', status: queued },
    );
    if (!woken) {
      throw new Error(
        `Task ${task.taskId} of open decision ${decisionId} is ${task.status}/${task.waitReason}, not waiting for it`,
      );
    }
    await events.append(tx, {
      type: EVENT['decision.resolved'],
      task: woken,
      payload: { decisionId },
    });
    await events.append(tx, {
      type: EVENT['task.queued'],
      task: woken,
      payload: { cause: 'decision', decisionId, from: waiting },
    });
    return { outcome: 'resolved', taskId: task.taskId, rootId: task.rootId };
  }
}
