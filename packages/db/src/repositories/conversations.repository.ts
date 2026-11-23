import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Db } from '../db';
import {
  agents,
  agentVersions,
  conversations,
  identityUsers,
  messages,
  runtimeTasks,
} from '../schema';

/**
 * A conversation with its origin read through its version (data-model design-agents.md, «Происхождение для
 * вида»): the agent of the version, its kind and current name, the version's number, the agent's owner with
 * the owner's current name (`null` — a system agent) and the key of a default agent.
 */
export type ConversationRow = typeof conversations.$inferSelect & {
  readonly agentId: string;
  readonly agentKind: string;
  readonly versionNumber: number;
  readonly agentName: string;
  readonly agentOwnerId: string | null;
  readonly agentOwnerName: string | null;
  readonly builtinKey: string | null;
};

/** What a new session is written with; a root (`parentId` null) also gets an empty title and its list time. */
export type NewConversationRow = Pick<
  typeof conversations.$inferInsert,
  | 'id'
  | 'parentId'
  | 'ownerId'
  | 'startCallId'
  | 'name'
  | 'description'
  | 'model'
  | 'agentVersionId'
  | 'subagent'
  | 'firstRun'
  | 'forkedThroughSeq'
>;

/**
 * The columns of a root session's row its owner lists it by. `title` and `updatedAt` are set on every root
 * and only there; the service narrows them.
 */
export interface RootConversationRow {
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
 * A root's row: a conversation without a parent (data-model design-schema.md KD-1). The condition of
 * `conversations_owner_page_idx`, word for word, so the owner's list keeps its index.
 */
const isRoot = isNull(conversations.parentId);

/**
 * The conversation's task is not deleted: the one deletion mark lives on the tasks of the tree (KD-2), and a
 * query of conversations joins the task by id to read it.
 */
const isLive = isNull(runtimeTasks.deletedAt);

const ownedRoot = (rootId: string, ownerId: string) =>
  and(eq(conversations.id, rootId), eq(conversations.ownerId, ownerId), isRoot);

/** The live root `rootId` of the owner, as a condition an `UPDATE` can carry: the task is read by a subquery. */
const ownedLiveRoot = (rootId: string, ownerId: string) =>
  and(
    ownedRoot(rootId, ownerId),
    sql`exists (select 1 from ${runtimeTasks} where ${runtimeTasks.taskId} = ${conversations.id} and ${runtimeTasks.deletedAt} is null)`,
  );

const CONVERSATION_COLUMNS = {
  ...getTableColumns(conversations),
  agentId: agents.id,
  agentKind: agents.kind,
  versionNumber: agentVersions.number,
  agentName: agents.name,
  agentOwnerId: agents.ownerId,
  agentOwnerName: identityUsers.name,
  builtinKey: agents.builtinKey,
};

const ROOT_COLUMNS = {
  rootId: conversations.id,
  ownerId: conversations.ownerId,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

/**
 * Drizzle queries of `conversations`: one row per agent, keyed by its runtime task. No method opens a transaction.
 */
@Injectable()
export class ConversationsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Whether the owner has a conversation on a version of the agent other than `taskId`. */
  async ranBefore(
    ownerId: string,
    agentId: string,
    taskId: string,
  ): Promise<boolean> {
    const [row] = await this.db.client
      .select({ sessions: count() })
      .from(conversations)
      .innerJoin(
        agentVersions,
        eq(agentVersions.id, conversations.agentVersionId),
      )
      .where(
        and(
          eq(conversations.ownerId, ownerId),
          eq(agentVersions.agentId, agentId),
          ne(conversations.id, taskId),
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
  async create(
    session: NewConversationRow,
    taskEntry: unknown,
  ): Promise<boolean> {
    const created = await this.db.client
      .insert(conversations)
      .values({
        ...session,
        ...(session.parentId === null ? { title: '', updatedAt: NOW_MS } : {}),
      })
      .onConflictDoNothing({ target: conversations.id })
      .returning({ id: conversations.id });
    if (created.length === 0) return false;
    await this.db.client.insert(messages).values({
      conversationId: session.id,
      seq: TASK_ENTRY_SEQ,
      kind: 'task',
      content: taskEntry,
    });
    return true;
  }

  /** The session row of the agent with its origin; `undefined` when it has none yet. */
  async find(taskId: string): Promise<ConversationRow | undefined> {
    const [row] = await this.withOrigin(eq(conversations.id, taskId));
    return row;
  }

  /** The session rows of the given agents with their origins; an agent without a session is absent. */
  async findMany(taskIds: readonly string[]): Promise<ConversationRow[]> {
    if (taskIds.length === 0) return [];
    return this.withOrigin(inArray(conversations.id, [...taskIds]));
  }

  /**
   * How many runs of each agent the owner started, through the versions of their conversations, for the
   * order of the chat listing (KD-4): only runs of the agent itself — a subagent runs on its deep agent's
   * version and a fork on its source's, so neither counts — and never a root session, which the employee
   * starts by writing.
   */
  recordCounts(
    ownerId: string,
  ): Promise<{ recordId: string; sessions: number }[]> {
    return this.db.client
      .select({ recordId: agentVersions.agentId, sessions: count() })
      .from(conversations)
      .innerJoin(
        agentVersions,
        eq(agentVersions.id, conversations.agentVersionId),
      )
      .where(
        and(
          eq(conversations.ownerId, ownerId),
          isNotNull(conversations.parentId),
          isNull(conversations.subagent),
          isNull(conversations.forkedThroughSeq),
        ),
      )
      .groupBy(agentVersions.agentId);
  }

  /** The root of the agent's tree, from its task; `undefined` when the agent has no conversation. */
  async rootIdOf(taskId: string): Promise<string | undefined> {
    const [row] = await this.db.client
      .select({ rootId: runtimeTasks.rootId })
      .from(conversations)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .where(eq(conversations.id, taskId));
    return row?.rootId;
  }

  /** Writes the given fields of the session; an empty patch writes nothing. */
  async update(taskId: string, patch: SessionPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await this.db.client
      .update(conversations)
      .set(patch)
      .where(eq(conversations.id, taskId));
  }

  /**
   * The owner's root session; another owner's, a deleted one and a session that is not a root are as absent
   * as a missing one.
   */
  async root(
    rootId: string,
    ownerId: string,
  ): Promise<RootConversationRow | undefined> {
    const [row] = await this.db.client
      .select(ROOT_COLUMNS)
      .from(conversations)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .where(and(ownedRoot(rootId, ownerId), isLive));
    return row;
  }

  /** The owner of a live root session, whoever it is; `undefined` when `rootId` names no live root session. */
  async rootOwner(rootId: string): Promise<string | undefined> {
    const [row] = await this.db.client
      .select({ ownerId: conversations.ownerId })
      .from(conversations)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .where(and(eq(conversations.id, rootId), isRoot, isLive));
    return row?.ownerId;
  }

  /**
   * The owner's root sessions, last changed first (`updated_at DESC, id DESC`, the order of
   * `conversations_owner_page_idx`): strictly after `after`, at most `limit`; all of them without either. Each
   * row finds its task by primary key and a deleted one is dropped.
   */
  roots(
    ownerId: string,
    page: { readonly after?: RootPosition; readonly limit?: number } = {},
  ): Promise<RootConversationRow[]> {
    const owned = and(eq(conversations.ownerId, ownerId), isRoot, isLive);
    const { after } = page;
    const query = this.db.client
      .select(ROOT_COLUMNS)
      .from(conversations)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .where(
        after === undefined
          ? owned
          : and(
              owned,
              sql`(${conversations.updatedAt}, ${conversations.id}) < (${after.updatedAt.toISOString()}::timestamptz, ${after.rootId}::uuid)`,
            ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.id));
    return page.limit === undefined ? query : query.limit(page.limit);
  }

  /** `updated_at = now()`: the owner's root session moves to the top of the list. */
  async touchRoot(rootId: string, ownerId: string): Promise<void> {
    await this.db.client
      .update(conversations)
      .set({ updatedAt: NOW_MS })
      .where(ownedLiveRoot(rootId, ownerId));
  }

  /** Sets the owner's title and moves the root session up; `undefined` for a missing or another owner's one. */
  async renameRoot(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<RootConversationRow | undefined> {
    const [row] = await this.db.client
      .update(conversations)
      .set({ title, updatedAt: NOW_MS })
      .where(ownedLiveRoot(rootId, ownerId))
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
      .update(conversations)
      .set({ title })
      .where(and(ownedLiveRoot(rootId, ownerId), eq(conversations.title, '')))
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  /** Conversations meeting the condition, each joined to its version, the version's agent and the agent's owner. */
  private withOrigin(where: SQL | undefined): Promise<ConversationRow[]> {
    return this.db.client
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .innerJoin(
        agentVersions,
        eq(agentVersions.id, conversations.agentVersionId),
      )
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .leftJoin(identityUsers, eq(identityUsers.id, agents.ownerId))
      .where(where);
  }
}
