import { DecisionStatusSchema } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Db } from '../db';
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
 * Drizzle queries of `runtime_decisions`.
 */
@Injectable()
export class RuntimeDecisionsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Inserts an `open` request. */
  async insert(decision: NewRuntimeDecisionRow): Promise<RuntimeDecisionRow> {
    const [row] = await this.db.client
      .insert(runtimeDecisions)
      .values({ ...decision, status: open })
      .returning();
    return row;
  }

  /** The task's resolved request that no committed step has received yet. */
  async findUndelivered(taskId: string): Promise<RuntimeDecisionRow | undefined> {
    const [row] = await this.db.client
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
  async markDelivered(decisionId: string, stepNo: number): Promise<void> {
    await this.db.client
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
    decisionId: string,
    ownerId: string,
  ): Promise<RuntimeDecisionView | undefined> {
    const [row] = await this.db.client
      .select(VIEW_COLUMNS)
      .from(runtimeDecisions)
      .where(
        and(eq(runtimeDecisions.decisionId, decisionId), eq(runtimeDecisions.ownerId, ownerId)),
      );
    return row;
  }

  /** All requests of the owner's tree in any status, in creation order. */
  listTree(rootId: string, ownerId: string): Promise<RuntimeDecisionView[]> {
    return this.db.client
      .select(VIEW_COLUMNS)
      .from(runtimeDecisions)
      .where(and(eq(runtimeDecisions.rootId, rootId), eq(runtimeDecisions.ownerId, ownerId)))
      .orderBy(asc(runtimeDecisions.createdAt), asc(runtimeDecisions.decisionId));
  }

  /** The task and the owner of a request. */
  async findTaskAndOwner(
    decisionId: string,
  ): Promise<{ taskId: string; ownerId: string } | undefined> {
    const [row] = await this.db.client
      .select({ taskId: runtimeDecisions.taskId, ownerId: runtimeDecisions.ownerId })
      .from(runtimeDecisions)
      .where(eq(runtimeDecisions.decisionId, decisionId));
    return row;
  }

  async find(decisionId: string): Promise<RuntimeDecisionRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(runtimeDecisions)
      .where(eq(runtimeDecisions.decisionId, decisionId));
    return row;
  }

  /** Writes the resolution of an `open` request; `false` when the request is not open. */
  async resolve(decisionId: string, resolution: unknown): Promise<boolean> {
    const rows = await this.db.client
      .update(runtimeDecisions)
      .set({ status: resolved, resolution: resolution ?? null, resolvedAt: sql`now()` })
      .where(and(eq(runtimeDecisions.decisionId, decisionId), eq(runtimeDecisions.status, open)))
      .returning({ decisionId: runtimeDecisions.decisionId });
    return rows.length > 0;
  }

  /** Cancels the open requests of the given tasks. */
  async cancelOpen(taskIds: readonly string[]): Promise<void> {
    await this.db.client
      .update(runtimeDecisions)
      .set({ status: cancelled })
      .where(
        and(inArray(runtimeDecisions.taskId, [...taskIds]), eq(runtimeDecisions.status, open)),
      );
  }
}
