import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { runtimeModelCalls, runtimeTasks } from '../schema';

export type NewRuntimeModelCallRow = Pick<
  typeof runtimeModelCalls.$inferInsert,
  | 'callId'
  | 'ownerId'
  | 'taskId'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'calledAt'
>;

/** Calls with `called_at` in `[from, to)`. */
export interface CalledWindow {
  from: Date;
  to: Date;
}

/**
 * Drizzle queries of `runtime_model_calls`, the rows of the token ledger: one per finished model
 * call. Rows are only inserted and summed; they outlive the deletion of their task tree.
 */
export class RuntimeModelCallsRepository {
  constructor(private readonly db: Db) {}

  async insert(call: NewRuntimeModelCallRow): Promise<void> {
    await this.db.client.insert(runtimeModelCalls).values(call);
  }

  /** Cost and number of the owner's calls in the window; an empty window gives zeros. */
  async sumOwned(
    ownerId: string,
    window: CalledWindow,
  ): Promise<{ costUsd: string; calls: number } | undefined> {
    const [row] = await this.db.client
      .select({
        costUsd: sql<string>`coalesce(sum(${runtimeModelCalls.costUsd}), 0)`,
        calls: sql<number>`count(*)::int`,
      })
      .from(runtimeModelCalls)
      .where(ownedIn(ownerId, window));
    return row;
  }

  /** Cost of the owner's calls in the window by model; a model with no call in it is absent. */
  sumOwnedByModel(
    ownerId: string,
    window: CalledWindow,
  ): Promise<{ model: string; costUsd: string }[]> {
    return this.db.client
      .select({
        model: runtimeModelCalls.model,
        costUsd: sql<string>`sum(${runtimeModelCalls.costUsd})`,
      })
      .from(runtimeModelCalls)
      .where(ownedIn(ownerId, window))
      .groupBy(runtimeModelCalls.model);
  }

  /** Cost of the calls of every task with this `root_id`; a tree with no call gives zero. */
  async sumTree(rootId: string): Promise<string> {
    const [row] = await this.db.client
      .select({
        costUsd: sql<string>`coalesce(sum(${runtimeModelCalls.costUsd}), 0)`,
      })
      .from(runtimeModelCalls)
      .innerJoin(
        runtimeTasks,
        eq(runtimeTasks.taskId, runtimeModelCalls.taskId),
      )
      .where(eq(runtimeTasks.rootId, rootId));
    return row!.costUsd;
  }

  /** Cost of the calls of the given tasks; none gives zero. */
  async sumTasks(taskIds: readonly string[]): Promise<string> {
    if (taskIds.length === 0) return '0';
    const [row] = await this.db.client
      .select({
        costUsd: sql<string>`coalesce(sum(${runtimeModelCalls.costUsd}), 0)`,
      })
      .from(runtimeModelCalls)
      .where(inArray(runtimeModelCalls.taskId, [...taskIds]));
    return row!.costUsd;
  }
}

function ownedIn(ownerId: string, window: CalledWindow) {
  return and(
    eq(runtimeModelCalls.ownerId, ownerId),
    gte(runtimeModelCalls.calledAt, window.from),
    lt(runtimeModelCalls.calledAt, window.to),
  );
}
