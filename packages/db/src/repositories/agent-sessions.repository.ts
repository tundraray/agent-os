import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { Db } from '../db';
import { agentMessages, agentSessions } from '../schema';

export type AgentSessionRow = typeof agentSessions.$inferSelect;

/** What a new session is written with; a root (`parentId` null) also gets an empty title and its list time. */
export type NewAgentSessionRow = Pick<
  typeof agentSessions.$inferInsert,
  | 'taskId'
  | 'parentId'
  | 'rootId'
  | 'ownerId'
  | 'name'
  | 'description'
  | 'model'
  | 'prompt'
  | 'recordId'
  | 'recordKind'
  | 'recordVersion'
  | 'recordName'
  | 'authorId'
  | 'authorName'
  | 'builtinKey'
  | 'subagent'
  | 'firstRun'
  | 'forkedFromTaskId'
  | 'forkedThroughSeq'
>;

/**
 * The columns of a root session's row its owner lists it by. `title` and `updatedAt` are set on every root
 * and only there; the service narrows them.
 */
export interface RootSessionRow {
  readonly rootId: string;
  readonly ownerId: string;
  readonly title: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

/** The position of a root session in the owner's list: the cursor of the next page. */
export interface RootPosition {
  readonly updatedAt: Date;
  readonly rootId: string;
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

/**
 * The list time is written truncated to milliseconds: the list cursor keeps it in ms, so the order of
 * the rows and the cursor's comparison read the same value.
 */
const NOW_MS = sql<Date>`date_trunc('milliseconds', now())`;

/**
 * A live root session's row: `title` and `updated_at` are set on every root and only there; a deleted
 * conversation's root (`deleted_at`) answers as a missing one. The condition of
 * `agent_sessions_owner_page_idx`, word for word, so the owner's list keeps its index.
 */
const isRoot = and(isNotNull(agentSessions.updatedAt), isNull(agentSessions.deletedAt));

const ownedRoot = (rootId: string, ownerId: string) =>
  and(eq(agentSessions.taskId, rootId), eq(agentSessions.ownerId, ownerId), isRoot);

const ROOT_COLUMNS = {
  rootId: agentSessions.taskId,
  ownerId: agentSessions.ownerId,
  title: agentSessions.title,
  createdAt: agentSessions.createdAt,
  updatedAt: agentSessions.updatedAt,
};

/**
 * Drizzle queries of `agent_sessions`: one row per agent, keyed by its runtime task. No method opens a transaction.
 */
@Injectable()
export class AgentSessionsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Whether the owner has a session of this record other than `taskId`. */
  async ranBefore(
    ownerId: string,
    recordId: string,
    taskId: string,
  ): Promise<boolean> {
    const [row] = await this.db.client
      .select({ sessions: count() })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.ownerId, ownerId),
          eq(agentSessions.recordId, recordId),
          ne(agentSessions.taskId, taskId),
        ),
      );
    return (row?.sessions ?? 0) > 0;
  }

  /**
   * Inserts the session and its `task` entry with `seq` 1 unless the session exists: both the
   * starter and the agent's first step call it, and `ON CONFLICT DO NOTHING` keeps their race safe.
   * A root session starts with an empty title and its list time. `true` — this call created the
   * session.
   */
  async create(session: NewAgentSessionRow, taskEntry: unknown): Promise<boolean> {
    const created = await this.db.client
      .insert(agentSessions)
      .values({
        ...session,
        ...(session.parentId === null ? { title: '', updatedAt: NOW_MS } : {}),
      })
      .onConflictDoNothing({ target: agentSessions.taskId })
      .returning({ taskId: agentSessions.taskId });
    if (created.length === 0) return false;
    await this.db.client.insert(agentMessages).values({
      taskId: session.taskId,
      seq: TASK_ENTRY_SEQ,
      kind: 'task',
      content: taskEntry,
    });
    return true;
  }

  /** The session row of the agent; `undefined` when it has none yet. */
  async find(taskId: string): Promise<AgentSessionRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.taskId, taskId));
    return row;
  }

  /** The session rows of the given agents; an agent without a session is absent. */
  async findMany(taskIds: readonly string[]): Promise<AgentSessionRow[]> {
    if (taskIds.length === 0) return [];
    return this.db.client
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.taskId, [...taskIds]));
  }

  /**
   * How many runs of each record the owner started, for the order of the chat listing (KD-4): only
   * sessions of the record itself — a subagent carries its deep agent's record id and a fork its
   * source's, so neither counts — and never a root session, which the employee starts by writing.
   */
  recordCounts(ownerId: string): Promise<{ recordId: string; sessions: number }[]> {
    return this.db.client
      .select({ recordId: agentSessions.recordId, sessions: count() })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.ownerId, ownerId),
          isNotNull(agentSessions.parentId),
          isNull(agentSessions.subagent),
          isNull(agentSessions.forkedFromTaskId),
        ),
      )
      .groupBy(agentSessions.recordId);
  }

  /** The root of the agent's tree, from its session; `undefined` when it has none. */
  async rootIdOf(taskId: string): Promise<string | undefined> {
    const [row] = await this.db.client
      .select({ rootId: agentSessions.rootId })
      .from(agentSessions)
      .where(eq(agentSessions.taskId, taskId));
    return row?.rootId;
  }

  /**
   * Marks the root session deleted: from then on the conversation answers as a missing one. The row
   * stays; the caller has deleted the runtime tree in the same transaction.
   */
  async markDeleted(rootId: string): Promise<void> {
    await this.db.client
      .update(agentSessions)
      .set({ deletedAt: sql`now()` })
      .where(eq(agentSessions.taskId, rootId));
  }

  /** Writes the given fields of the session; an empty patch writes nothing. */
  async update(taskId: string, patch: SessionPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await this.db.client.update(agentSessions).set(patch).where(eq(agentSessions.taskId, taskId));
  }

  /** The owner's root session; another owner's and a session that is not a root are as absent as a missing one. */
  async root(rootId: string, ownerId: string): Promise<RootSessionRow | undefined> {
    const [row] = await this.db.client
      .select(ROOT_COLUMNS)
      .from(agentSessions)
      .where(ownedRoot(rootId, ownerId));
    return row;
  }

  /** The owner of a root session, whoever it is; `undefined` when `rootId` names no root session. */
  async rootOwner(rootId: string): Promise<string | undefined> {
    const [row] = await this.db.client
      .select({ ownerId: agentSessions.ownerId })
      .from(agentSessions)
      .where(and(eq(agentSessions.taskId, rootId), isRoot));
    return row?.ownerId;
  }

  /**
   * The owner's root sessions, last changed first (`updated_at DESC, task_id DESC`, the order of
   * `agent_sessions_owner_page_idx`): strictly after `after`, at most `limit`; all of them without either.
   */
  roots(
    ownerId: string,
    page: { readonly after?: RootPosition; readonly limit?: number } = {},
  ): Promise<RootSessionRow[]> {
    const owned = and(eq(agentSessions.ownerId, ownerId), isRoot);
    const { after } = page;
    const query = this.db.client
      .select(ROOT_COLUMNS)
      .from(agentSessions)
      .where(
        after === undefined
          ? owned
          : and(
              owned,
              sql`(${agentSessions.updatedAt}, ${agentSessions.taskId}) < (${after.updatedAt.toISOString()}::timestamptz, ${after.rootId}::uuid)`,
            ),
      )
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.taskId));
    return page.limit === undefined ? query : query.limit(page.limit);
  }

  /** `updated_at = now()`: the owner's root session moves to the top of the list. */
  async touchRoot(rootId: string, ownerId: string): Promise<void> {
    await this.db.client
      .update(agentSessions)
      .set({ updatedAt: NOW_MS })
      .where(ownedRoot(rootId, ownerId));
  }

  /** Sets the owner's title and moves the root session up; `undefined` for a missing or another owner's one. */
  async renameRoot(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<RootSessionRow | undefined> {
    const [row] = await this.db.client
      .update(agentSessions)
      .set({ title, updatedAt: NOW_MS })
      .where(ownedRoot(rootId, ownerId))
      .returning(ROOT_COLUMNS);
    return row;
  }

  /** Writes a generated title only into an empty one; `true` when it was written. */
  async titleRootIfEmpty(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<boolean> {
    const rows = await this.db.client
      .update(agentSessions)
      .set({ title })
      .where(and(ownedRoot(rootId, ownerId), eq(agentSessions.title, '')))
      .returning({ taskId: agentSessions.taskId });
    return rows.length > 0;
  }
}
