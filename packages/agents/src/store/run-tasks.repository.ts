import { type RunTaskStatus, RunTaskStatusSchema } from '@agent-os/contracts';
import { agentRunTasks } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { StoreReader } from './sessions.repository';

/** An item of a run's task list (deep-agents KD-5): its number in the run from 1, its text and status. */
export interface RunTask {
  readonly number: number;
  readonly text: string;
  readonly status: RunTaskStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A new item: the number the caller gave it after the run's last one, and its text. */
export interface NewRunTask {
  readonly number: number;
  readonly text: string;
}

/**
 * `agent_run_tasks` inside the caller's transaction (repository over a transaction): the task list of a
 * deep agent's run, keyed by its session. Only the steps of that session write it, one at a time and in
 * the step's commit, so the items change together with the `tool_result` of the call that changed them
 * (Invariant 1). No function opens a transaction; numbers are never changed or deleted (Invariant 2).
 */
export const runTasks = {
  /** The run's items by number; empty for a session without a list. */
  async list(reader: StoreReader, taskId: string): Promise<RunTask[]> {
    const rows = await reader
      .select({
        number: agentRunTasks.number,
        text: agentRunTasks.text,
        status: agentRunTasks.status,
        createdAt: agentRunTasks.createdAt,
        updatedAt: agentRunTasks.updatedAt,
      })
      .from(agentRunTasks)
      .where(eq(agentRunTasks.taskId, taskId))
      .orderBy(asc(agentRunTasks.number));
    return rows.map((row) => ({ ...row, status: RunTaskStatusSchema.parse(row.status) }));
  },

  /** Adds items with the numbers given, `waiting`; a taken number violates the primary key and fails the commit. */
  async insert(tx: RuntimeTx, taskId: string, items: readonly NewRunTask[]): Promise<void> {
    if (items.length === 0) return;
    await tx.insert(agentRunTasks).values(items.map((item) => ({ taskId, number: item.number, text: item.text })));
  },

  /** Sets the status of an existing item and its change time. */
  async setStatus(tx: RuntimeTx, taskId: string, number: number, status: RunTaskStatus): Promise<void> {
    await tx
      .update(agentRunTasks)
      .set({ status, updatedAt: sql`now()` })
      .where(and(eq(agentRunTasks.taskId, taskId), eq(agentRunTasks.number, number)));
  },
};
