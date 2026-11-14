import { agentMessages, agentSessions, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { eq, inArray } from 'drizzle-orm';

import { HistoryContentSchemas } from '../history/history.js';
import { type SessionLimits, SessionLimitsSchema } from '../tools/tool.js';

/** A reader of the store: the step's transaction, or the database for a read outside a step. */
export type StoreReader = Database | RuntimeTx;

/**
 * What a session is made of: the input of an `agent` task (plan Notes 3). The model is already chosen;
 * the first step makes the session from it when the starter did not.
 */
export interface SessionInput {
  readonly definition: string;
  readonly description: string;
  readonly prompt: string;
  readonly model: string;
  readonly limits?: SessionLimits;
  readonly forkedFrom?: { readonly agentId: string; readonly throughSeq: number };
}

/** An `agent_sessions` row with its limits read back as {@link SessionLimits}. */
export interface Session {
  readonly taskId: string;
  readonly ownerId: string;
  readonly definition: string;
  readonly description: string;
  readonly model: string;
  readonly prompt: string;
  readonly limits: SessionLimits | null;
  readonly forkedFromTaskId: string | null;
  readonly forkedThroughSeq: number | null;
  readonly turns: number;
  readonly interrupted: boolean;
  readonly closed: boolean;
  readonly lastInputTokens: number | null;
  readonly createdAt: Date;
}

/** The fields of a session a step changes: the turn counter, the marks and the compaction driver. */
export interface SessionPatch {
  readonly turns?: number;
  readonly interrupted?: boolean;
  readonly closed?: boolean;
  readonly lastInputTokens?: number | null;
}

/** Seq of the `task` entry: the first own entry of every session. */
const TASK_ENTRY_SEQ = 1;

function toSession(row: typeof agentSessions.$inferSelect): Session {
  return { ...row, limits: SessionLimitsSchema.nullable().parse(row.limits) };
}

/**
 * `agent_sessions` inside the caller's transaction (repository over a transaction): one row per agent,
 * keyed by its runtime task. No function opens a transaction.
 */
export const sessions = {
  /**
   * Creates the session and its `task` entry with `seq` 1 unless the session exists (plan Notes 11):
   * both the `start` operation and the agent's first step call it, and `ON CONFLICT DO NOTHING` keeps
   * their race safe. `true` when this call created the session.
   */
  async ensureSession(
    tx: RuntimeTx,
    taskId: string,
    input: SessionInput,
    ownerId: string,
  ): Promise<boolean> {
    const created = await tx
      .insert(agentSessions)
      .values({
        taskId,
        ownerId,
        definition: input.definition,
        description: input.description,
        model: input.model,
        prompt: input.prompt,
        limits: input.limits ?? null,
        forkedFromTaskId: input.forkedFrom?.agentId ?? null,
        forkedThroughSeq: input.forkedFrom?.throughSeq ?? null,
      })
      .onConflictDoNothing({ target: agentSessions.taskId })
      .returning({ taskId: agentSessions.taskId });
    if (created.length === 0) return false;
    await tx
      .insert(agentMessages)
      .values({
        taskId,
        seq: TASK_ENTRY_SEQ,
        kind: 'task',
        content: HistoryContentSchemas.task.parse({ text: input.prompt }),
      })
      .onConflictDoNothing();
    return true;
  },

  /** The session of the agent; `undefined` when it has none yet. */
  async get(reader: StoreReader, taskId: string): Promise<Session | undefined> {
    const [row] = await reader
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.taskId, taskId));
    return row === undefined ? undefined : toSession(row);
  },

  /** The sessions of the given agents by task id; an agent without a session is absent. */
  async getMany(
    reader: StoreReader,
    taskIds: readonly string[],
  ): Promise<Map<string, Session>> {
    if (taskIds.length === 0) return new Map();
    const rows = await reader
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.taskId, [...taskIds]));
    return new Map(rows.map((row) => [row.taskId, toSession(row)]));
  },

  /** Writes the given fields of the session; an empty patch writes nothing. */
  async update(tx: RuntimeTx, taskId: string, patch: SessionPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await tx.update(agentSessions).set(patch).where(eq(agentSessions.taskId, taskId));
  },
};
