import {
  type SessionTaskStatus,
  SessionTaskStatusSchema,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Db } from '../db';
import { conversations, conversationTasks } from '../schema';

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
 * Drizzle queries of `conversation_tasks` and `conversations.last_task_number` (KD-1, KD-3). Only the steps of the session write them, one at
 * a time and in the step's commit, so the list changes together with the `tool_result` of the call that
 * changed it. No method opens a transaction.
 */
@Injectable()
export class ConversationTasksRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** The session's tasks by number; empty for a session without a list. */
  async list(sessionId: string): Promise<SessionTask[]> {
    const rows = await this.db.client
      .select({
        number: conversationTasks.number,
        subject: conversationTasks.subject,
        description: conversationTasks.description,
        activeForm: conversationTasks.activeForm,
        status: conversationTasks.status,
        owner: conversationTasks.owner,
        blockedBy: conversationTasks.blockedBy,
      })
      .from(conversationTasks)
      .where(eq(conversationTasks.conversationId, sessionId))
      .orderBy(asc(conversationTasks.number));
    return rows.map((row) => ({
      ...row,
      status: SessionTaskStatusSchema.parse(row.status),
    }));
  }

  /** The list and the last number given, as the rules decide on them. */
  async read(
    sessionId: string,
  ): Promise<{ tasks: SessionTask[]; lastNumber: number }> {
    const [session] = await this.db.client
      .select({ lastNumber: conversations.lastTaskNumber })
      .from(conversations)
      .where(eq(conversations.id, sessionId));
    if (session === undefined)
      throw new Error(`Session ${sessionId} has no row`);
    return {
      tasks: await this.list(sessionId),
      lastNumber: session.lastNumber,
    };
  }

  /** Writes a decision: the tasks whole (created or replaced), the deletions and the counter. */
  async write(sessionId: string, change: SessionTasksWrite): Promise<void> {
    if (change.deleted.length > 0) {
      await this.db.client
        .delete(conversationTasks)
        .where(
          and(
            eq(conversationTasks.conversationId, sessionId),
            inArray(conversationTasks.number, [...change.deleted]),
          ),
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
      await this.db.client
        .insert(conversationTasks)
        .values({ conversationId: sessionId, number: task.number, ...row })
        .onConflictDoUpdate({
          target: [conversationTasks.conversationId, conversationTasks.number],
          set: { ...row, updatedAt: sql`now()` },
        });
    }
    await this.db.client
      .update(conversations)
      .set({ lastTaskNumber: change.lastNumber })
      .where(eq(conversations.id, sessionId));
  }
}
