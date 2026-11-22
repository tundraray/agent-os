import { type SessionTaskStatus, SessionTaskStatusSchema } from '@agent-os/contracts';
import { agentSessions, agentSessionTasks, type Executor, type Transaction } from '@agent-os/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';


/** A task of a session's list (deep-agents design-task-list.md, Data Model). */
export interface SessionTask {
  /** Its number in the session, from 1; never given again. */
  readonly number: number;
  readonly subject: string;
  readonly description: string;
  readonly activeForm: string | null;
  readonly status: SessionTaskStatus;
  /** A free label; the `task` assignment writes a subagent's name into it. */
  readonly owner: string | null;
  /** Numbers of the tasks of the same list that must be completed first. */
  readonly blockedBy: readonly number[];
}

/** What a step writes: the tasks created or changed, whole, the numbers deleted and the new counter. */
export interface SessionTasksWrite {
  readonly written: readonly SessionTask[];
  readonly deleted: readonly number[];
  readonly lastNumber: number;
}

/**
 * `agent_session_tasks` and `agent_sessions.last_task_number` inside the caller's transaction (repository over a
 * transaction; KD-1, KD-3). Only the steps of the session write them, one at a time and in the step's commit,
 * so the list changes together with the `tool_result` of the call that changed it. No function opens a
 * transaction.
 */
export const sessionTasks = {
  /** The session's tasks by number; empty for a session without a list. */
  async list(reader: Executor, sessionId: string): Promise<SessionTask[]> {
    const rows = await reader
      .select({
        number: agentSessionTasks.number,
        subject: agentSessionTasks.subject,
        description: agentSessionTasks.description,
        activeForm: agentSessionTasks.activeForm,
        status: agentSessionTasks.status,
        owner: agentSessionTasks.owner,
        blockedBy: agentSessionTasks.blockedBy,
      })
      .from(agentSessionTasks)
      .where(eq(agentSessionTasks.taskId, sessionId))
      .orderBy(asc(agentSessionTasks.number));
    return rows.map((row) => ({ ...row, status: SessionTaskStatusSchema.parse(row.status) }));
  },

  /** The list and the last number given, as the rules decide on them. */
  async read(
    reader: Executor,
    sessionId: string,
  ): Promise<{ tasks: SessionTask[]; lastNumber: number }> {
    const [session] = await reader
      .select({ lastNumber: agentSessions.lastTaskNumber })
      .from(agentSessions)
      .where(eq(agentSessions.taskId, sessionId));
    if (session === undefined) throw new Error(`Session ${sessionId} has no row`);
    return { tasks: await sessionTasks.list(reader, sessionId), lastNumber: session.lastNumber };
  },

  /** Writes a decision: the tasks whole (created or replaced), the deletions and the counter. */
  async write(tx: Transaction, sessionId: string, change: SessionTasksWrite): Promise<void> {
    if (change.deleted.length > 0) {
      await tx
        .delete(agentSessionTasks)
        .where(
          and(eq(agentSessionTasks.taskId, sessionId), inArray(agentSessionTasks.number, [...change.deleted])),
        );
    }
    for (const task of change.written) {
      const row = {
        subject: task.subject,
        description: task.description,
        activeForm: task.activeForm,
        status: task.status,
        owner: task.owner,
        blockedBy: [...task.blockedBy],
      };
      await tx
        .insert(agentSessionTasks)
        .values({ taskId: sessionId, number: task.number, ...row })
        .onConflictDoUpdate({
          target: [agentSessionTasks.taskId, agentSessionTasks.number],
          set: { ...row, updatedAt: sql`now()` },
        });
    }
    await tx
      .update(agentSessions)
      .set({ lastTaskNumber: change.lastNumber })
      .where(eq(agentSessions.taskId, sessionId));
  },
};
