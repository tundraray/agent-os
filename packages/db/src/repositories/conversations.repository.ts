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
import { alias } from 'drizzle-orm/pg-core';
import {
  CHAT_TASK_TYPE,
  DEEP_AGENT_TASK_TYPE,
  HistoryEntryKindSchema,
  HistoryEventSchema,
  TaskStatusSchema,
  WaitReasonSchema,
  type ToolPair,
} from '@agent-os/contracts';
import type { Db } from '../db';
import {
  agents,
  agentVersions,
  codeCalls,
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
  /** The type of the root's task. */
  readonly type: string;
  readonly forkedFromId: string | null;
  readonly forkedThroughSeq: number | null;
  /** The title of the fork's source; `null` when it was deleted or this is no fork. */
  readonly forkedFromTitle: string | null;
  /** The live forks of this conversation. */
  readonly forkCount: number;
  /** The last entry of the root's history the owner has seen. */
  readonly seenThroughSeq: number;
}

/**
 * The facts of a root's tree its list state is read from (improvements design-server.md, «How the conversation
 * state works»): an unfinished question in the tree, the root neither finished nor waiting for a message, an
 * unfinished agent task under it, the seq of the root's last answer without calls and last `failed` event (`null`
 * — none) and its «seen through» mark.
 */
export interface ConversationStateFactsRow {
  readonly rootId: string;
  readonly questionOpen: boolean;
  readonly rootAnswering: boolean;
  readonly agentsWorking: boolean;
  readonly lastAnswerSeq: number | null;
  readonly lastFailureSeq: number | null;
  readonly seenThroughSeq: number;
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
  readonly overflowed?: boolean;
  readonly forkedFromId?: string;
  readonly forkedThroughSeq?: number;
  readonly seenThroughSeq?: number;
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

const { completed, failed, queued, running, waiting } = TaskStatusSchema.enum;

/** A fork's source and its task, joined only while the source is not deleted. */
const source = alias(conversations, 'source');
const sourceTask = alias(runtimeTasks, 'source_task');

const ROOT_COLUMNS = {
  rootId: conversations.id,
  ownerId: conversations.ownerId,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  type: runtimeTasks.type,
  forkedFromId: conversations.forkedFromId,
  forkedThroughSeq: conversations.forkedThroughSeq,
  forkedFromTitle: source.title,
  forkCount: sql<number>`(select count(*)::int from ${conversations} fork
    join ${runtimeTasks} fork_task on fork_task.task_id = fork.id
    where fork.forked_from_id = ${conversations.id} and fork_task.deleted_at is null)`,
  seenThroughSeq: conversations.seenThroughSeq,
};

const UNFINISHED = sql`(${sql.join(
  [queued, running, waiting].map((status) => sql`${status}`),
  sql`, `,
)})`;

/**
 * Drizzle queries of `conversations`: one row per agent, keyed by its runtime task. No method opens a transaction.
 */
export class ConversationsRepository {
  constructor(private readonly db: Db) {}

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
   * A root session starts with an empty title and its list time.
   */
  async create(session: NewConversationRow, taskEntry: unknown): Promise<void> {
    const created = await this.db.client
      .insert(conversations)
      .values({
        ...session,
        ...(session.parentId === null ? { title: '', updatedAt: NOW_MS } : {}),
      })
      .onConflictDoNothing({ target: conversations.id })
      .returning({ id: conversations.id });
    if (created.length === 0) return;
    await this.db.client.insert(messages).values({
      conversationId: session.id,
      seq: TASK_ENTRY_SEQ,
      kind: 'task',
      content: taskEntry,
    });
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
    const [row] = await this.selectRoots().where(
      and(ownedRoot(rootId, ownerId), isLive),
    );
    return row;
  }

  /** The owner's live forks of the conversation, newest first. */
  forks(sourceId: string, ownerId: string): Promise<RootConversationRow[]> {
    return this.selectRoots()
      .where(
        and(
          eq(conversations.forkedFromId, sourceId),
          eq(conversations.ownerId, ownerId),
          isRoot,
          isLive,
        ),
      )
      .orderBy(desc(conversations.createdAt), desc(conversations.id));
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
    const query = this.selectRoots()
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

  /** The pairs allowed to the root's conversation (`granted_tools`); empty for a missing root. */
  async grantedTools(rootId: string): Promise<ToolPair[]> {
    const [row] = await this.db.client
      .select({ grantedTools: conversations.grantedTools })
      .from(conversations)
      .where(and(eq(conversations.id, rootId), isRoot));
    return row?.grantedTools ?? [];
  }

  /** Adds the pair to the root's `granted_tools` in one `UPDATE`; a pair already there is not added again. */
  async grantTool(rootId: string, pair: ToolPair): Promise<void> {
    const added = JSON.stringify([{ server: pair.server, tool: pair.tool }]);
    await this.db.client
      .update(conversations)
      .set({
        grantedTools: sql`${conversations.grantedTools} || ${added}::jsonb`,
      })
      .where(
        and(
          eq(conversations.id, rootId),
          isRoot,
          sql`not (${conversations.grantedTools} @> ${added}::jsonb)`,
        ),
      );
  }

  /**
   * {@link ConversationStateFactsRow} of the given roots in one query; `questionType` is the task type of a question
   * to a human. Each fact reads the tree by `runtime_tasks_root_idx` and the history backwards by its key.
   */
  async stateFacts(
    rootIds: readonly string[],
    questionType: string,
  ): Promise<ConversationStateFactsRow[]> {
    if (rootIds.length === 0) return [];
    const lastSeq = (kind: string, condition: SQL) =>
      sql<
        number | null
      >`(select entry.seq from ${messages} entry where entry.conversation_id = ${conversations.id} and entry.kind = ${kind} and ${condition} order by entry.seq desc limit 1)`;
    return this.db.client
      .select({
        rootId: conversations.id,
        questionOpen: sql<boolean>`exists (select 1 from ${runtimeTasks} question where question.root_id = ${conversations.id} and question.type = ${questionType} and question.status in ${UNFINISHED})`,
        rootAnswering: sql<boolean>`(${runtimeTasks.status} in ${UNFINISHED} and ${runtimeTasks.waitReason} is distinct from ${WaitReasonSchema.enum.messages})`,
        agentsWorking: sql<boolean>`exists (select 1 from ${runtimeTasks} agent where agent.root_id = ${conversations.id} and agent.task_id <> ${conversations.id} and agent.type <> ${questionType} and agent.status in ${UNFINISHED})`,
        lastAnswerSeq: lastSeq(
          HistoryEntryKindSchema.enum.model_answer,
          sql`jsonb_array_length(entry.content -> 'toolCalls') = 0`,
        ),
        lastFailureSeq: lastSeq(
          HistoryEntryKindSchema.enum.event,
          sql`entry.content ->> 'event' = ${HistoryEventSchema.enum.failed}`,
        ),
        seenThroughSeq: conversations.seenThroughSeq,
      })
      .from(conversations)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .where(and(inArray(conversations.id, [...rootIds]), isRoot));
  }

  /**
   * Raises the owner's live root's «seen through» mark to `throughSeq`, cut to the root's last entry; the mark never
   * goes down. `false` for a missing or another owner's root.
   */
  async markSeen(
    rootId: string,
    ownerId: string,
    throughSeq: number,
  ): Promise<boolean> {
    const lastEntry = sql`(select coalesce(max(entry.seq), 0) from ${messages} entry where entry.conversation_id = ${conversations.id})`;
    const rows = await this.db.client
      .update(conversations)
      .set({
        seenThroughSeq: sql`greatest(${conversations.seenThroughSeq}, least(${throughSeq}::int, ${lastEntry}))`,
      })
      .where(ownedLiveRoot(rootId, ownerId))
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  /** `updated_at = now()`: the owner's root session moves to the top of the list. */
  async touchRoot(rootId: string, ownerId: string): Promise<void> {
    await this.db.client
      .update(conversations)
      .set({ updatedAt: NOW_MS })
      .where(ownedLiveRoot(rootId, ownerId));
  }

  /** Sets the owner's title and moves the root session up; `false` for a missing or another owner's one. */
  async renameRoot(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<boolean> {
    const rows = await this.db.client
      .update(conversations)
      .set({ title, updatedAt: NOW_MS })
      .where(ownedLiveRoot(rootId, ownerId))
      .returning({ id: conversations.id });
    return rows.length > 0;
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

  /**
   * The past tasks of an agent across every owner, newest first (self-learning design-training.md, KD-2): the
   * conversations of `deep_agent` tasks on the agent's versions directly under a chat, ended with an answer or an
   * error, not deleted. A training's and a replay's conversations are never among them: their root is no chat.
   * At most `limit`; with `conversationId`, only that conversation when it is one.
   */
  pastTasks(
    agentId: string,
    options: { readonly limit: number; readonly conversationId?: string },
  ): Promise<{ id: string }[]> {
    const parent = alias(runtimeTasks, 'parent');
    return this.db.client
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(
        agentVersions,
        eq(agentVersions.id, conversations.agentVersionId),
      )
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .innerJoin(parent, eq(parent.taskId, runtimeTasks.parentId))
      .where(
        and(
          eq(agentVersions.agentId, agentId),
          eq(runtimeTasks.type, DEEP_AGENT_TASK_TYPE),
          eq(parent.type, CHAT_TASK_TYPE),
          inArray(runtimeTasks.status, [completed, failed]),
          isLive,
          options.conversationId === undefined
            ? undefined
            : eq(conversations.id, options.conversationId),
        ),
      )
      .orderBy(desc(runtimeTasks.createdSeq))
      .limit(options.limit);
  }

  /**
   * The MCP tools each run called, with the subtree of its subagents: the calls of its model answers and the
   * calls its code made (`code_calls`), one row per run, server and tool.
   */
  async serversCalled(
    runIds: readonly string[],
  ): Promise<{ runId: string; server: string; tool: string }[]> {
    if (runIds.length === 0) return [];
    const ids = sql.join(
      runIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await this.db.client.execute<{
      runId: string;
      server: string;
      tool: string;
    }>(sql`
      with recursive tree (task_id, run_id) as (
        select task_id, task_id from ${runtimeTasks} where task_id in (${ids})
        union all
        select child.task_id, tree.run_id
        from ${runtimeTasks} child join tree on child.parent_id = tree.task_id
      )
      select distinct tree.run_id as "runId", called.server, called.tool
      from tree
      join lateral (
        select answer_call->>'server' as server, answer_call->>'tool' as tool
        from ${messages} answer, jsonb_array_elements(answer.content->'toolCalls') answer_call
        where answer.conversation_id = tree.task_id and answer.kind = 'model_answer'
        union all
        select code_call.server, code_call.tool
        from ${codeCalls} code_call
        where code_call.conversation_id = tree.task_id
      ) called on called.server is not null`);
    return result.rows;
  }

  /** Root rows with their task and, for a fork, its live source. */
  private selectRoots() {
    return this.db.client
      .select(ROOT_COLUMNS)
      .from(conversations)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .leftJoin(
        sourceTask,
        and(
          eq(sourceTask.taskId, conversations.forkedFromId),
          isNull(sourceTask.deletedAt),
        ),
      )
      .leftJoin(source, eq(source.id, sourceTask.taskId));
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
