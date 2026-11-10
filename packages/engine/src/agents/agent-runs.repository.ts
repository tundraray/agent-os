import { type Database, researchAgentRuns } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, isNull } from 'drizzle-orm';

export type AgentRunRow = typeof researchAgentRuns.$inferSelect;

/** What the first attempt of a run writes from its task input (design-agent-core.md, Data Model). */
export interface NewAgentRun {
  /** The run's `agent.run` or `agent.root` task. */
  readonly taskId: string;
  readonly investigationId: string;
  readonly agentName: string;
  /** The parent run and its call number; null for the root. */
  readonly parent: { readonly taskId: string; readonly callIndex: number } | null;
  /** 0 for the root. */
  readonly depth: number;
  /** Null for a form with a prologue, whose session has no assignment. */
  readonly assignment: string | null;
  /** The run's token share: its task's `maxTokens` (KD-4). */
  readonly shareTokens: number;
  readonly notAfter: Date;
  readonly sources: readonly string[];
}

/** How a run ended by itself: its result, or why it ended without one. */
export type AgentRunEnding = { readonly result: unknown } | { readonly failure: unknown };

/** `research_agent_runs`: one row per run; the run's status is its task's, which the table does not repeat. */
export const agentRunsRepository = {
  /**
   * Writes the run row inside a guarded transaction; a retried first attempt finds the row already there and writes
   * nothing. Returns whether this call wrote it.
   */
  async insert(tx: RuntimeTx, run: NewAgentRun): Promise<boolean> {
    const inserted = await tx
      .insert(researchAgentRuns)
      .values({
        taskId: run.taskId,
        investigationId: run.investigationId,
        agentName: run.agentName,
        parentTaskId: run.parent?.taskId ?? null,
        parentCallIndex: run.parent?.callIndex ?? null,
        depth: run.depth,
        assignment: run.assignment,
        shareTokens: run.shareTokens,
        notAfter: run.notAfter,
        sources: [...run.sources],
      })
      .onConflictDoNothing({ target: researchAgentRuns.taskId })
      .returning({ taskId: researchAgentRuns.taskId });
    return inserted.length === 1;
  },

  async read(db: Database | RuntimeTx, taskId: string): Promise<AgentRunRow | undefined> {
    const [row] = await db.select().from(researchAgentRuns).where(eq(researchAgentRuns.taskId, taskId));
    return row;
  },

  /** The runs an investigation's tree holds, oldest first. */
  ofInvestigation(db: Database | RuntimeTx, investigationId: string): Promise<AgentRunRow[]> {
    return db
      .select()
      .from(researchAgentRuns)
      .where(eq(researchAgentRuns.investigationId, investigationId))
      .orderBy(asc(researchAgentRuns.createdAt), asc(researchAgentRuns.taskId));
  },

  /**
   * Records the run's ending once, inside the guarded transaction that ends it; a later write finds an ending and
   * changes nothing. Returns whether this call wrote it.
   */
  async writeEnding(tx: RuntimeTx, taskId: string, ending: AgentRunEnding): Promise<boolean> {
    const values = 'result' in ending ? { result: ending.result } : { failure: ending.failure };
    const written = await tx
      .update(researchAgentRuns)
      .set(values)
      .where(and(eq(researchAgentRuns.taskId, taskId), isNull(researchAgentRuns.result), isNull(researchAgentRuns.failure)))
      .returning({ taskId: researchAgentRuns.taskId });
    return written.length === 1;
  },
};
