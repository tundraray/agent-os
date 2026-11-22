import { DecisionStatusSchema } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { runtimeDecisions } from '../schema';

export type RuntimeDecisionRow = typeof runtimeDecisions.$inferSelect;

export type NewRuntimeDecisionRow = Pick<
  typeof runtimeDecisions.$inferInsert,
  'decisionId' | 'taskId' | 'rootId' | 'ownerId' | 'kind' | 'payload'
>;

/** The columns of a request an employee reads: no owner, no delivery mark. */
export type RuntimeDecisionView = Pick<
  RuntimeDecisionRow,
  | 'decisionId'
  | 'taskId'
  | 'rootId'
  | 'kind'
  | 'payload'
  | 'status'
  | 'resolution'
  | 'createdAt'
  | 'resolvedAt'
>;

const { open, resolved, cancelled } = DecisionStatusSchema.enum;

const VIEW_COLUMNS = {
  decisionId: runtimeDecisions.decisionId,
  taskId: runtimeDecisions.taskId,
  rootId: runtimeDecisions.rootId,
  kind: runtimeDecisions.kind,
  payload: runtimeDecisions.payload,
  status: runtimeDecisions.status,
  resolution: runtimeDecisions.resolution,
  createdAt: runtimeDecisions.createdAt,
  resolvedAt: runtimeDecisions.resolvedAt,
};

/**
 * Drizzle queries of `runtime_decisions` (repository over a transaction). Lock order: the task
 * before its request, as in a step's commit and in a stop.
 */
@Injectable()
export class RuntimeDecisionsRepository {
  /** Inserts an `open` request. */
  async insert(tx: Transaction, decision: NewRuntimeDecisionRow): Promise<RuntimeDecisionRow> {
    const [row] = await tx
      .insert(runtimeDecisions)
      .values({ ...decision, status: open })
      .returning();
    return row;
  }

  /** The task's resolved request that no committed step has received yet. */
  async findUndelivered(tx: Transaction, taskId: string): Promise<RuntimeDecisionRow | undefined> {
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

  /** Hands the request to step `stepNo`; a request already handed over stays as it is. */
  async markDelivered(tx: Transaction, decisionId: string, stepNo: number): Promise<void> {
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

  /** The owner's request in any status; `undefined` for a missing or another owner's one. */
  async findOwned(
    executor: Executor,
    decisionId: string,
    ownerId: string,
  ): Promise<RuntimeDecisionView | undefined> {
    const [row] = await executor
      .select(VIEW_COLUMNS)
      .from(runtimeDecisions)
      .where(
        and(eq(runtimeDecisions.decisionId, decisionId), eq(runtimeDecisions.ownerId, ownerId)),
      );
    return row;
  }

  /** All requests of the owner's tree in any status, in creation order. */
  listTree(executor: Executor, rootId: string, ownerId: string): Promise<RuntimeDecisionView[]> {
    return executor
      .select(VIEW_COLUMNS)
      .from(runtimeDecisions)
      .where(and(eq(runtimeDecisions.rootId, rootId), eq(runtimeDecisions.ownerId, ownerId)))
      .orderBy(asc(runtimeDecisions.createdAt), asc(runtimeDecisions.decisionId));
  }

  /** The task and the owner of a request, without a lock. */
  async findTaskAndOwner(
    tx: Transaction,
    decisionId: string,
  ): Promise<{ taskId: string; ownerId: string } | undefined> {
    const [row] = await tx
      .select({ taskId: runtimeDecisions.taskId, ownerId: runtimeDecisions.ownerId })
      .from(runtimeDecisions)
      .where(eq(runtimeDecisions.decisionId, decisionId));
    return row;
  }

  /** Locks the request FOR UPDATE. */
  async lock(tx: Transaction, decisionId: string): Promise<RuntimeDecisionRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeDecisions)
      .where(eq(runtimeDecisions.decisionId, decisionId))
      .for('update');
    return row;
  }

  /** Writes the resolution of a request the caller holds locked and found `open`. */
  async resolve(tx: Transaction, decisionId: string, resolution: unknown): Promise<void> {
    await tx
      .update(runtimeDecisions)
      .set({ status: resolved, resolution: resolution ?? null, resolvedAt: sql`now()` })
      .where(eq(runtimeDecisions.decisionId, decisionId));
  }

  /** Cancels the open requests of the given tasks, whose locks the caller holds. */
  async cancelOpen(tx: Transaction, taskIds: readonly string[]): Promise<void> {
    await tx
      .update(runtimeDecisions)
      .set({ status: cancelled })
      .where(
        and(inArray(runtimeDecisions.taskId, [...taskIds]), eq(runtimeDecisions.status, open)),
      );
  }
}
