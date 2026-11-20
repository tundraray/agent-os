import { ChipRecordSchema, RecordKindSchema, type RunOrigin } from '@agent-os/contracts';
import { agentMessages, agentSessions, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { insertKnowledgeRun } from '../knowledge/knowledge-runs.repository.js';
import { RunSnapshotSchema } from '../start/snapshot.js';
import { learningRunOf, snapshotDefinition } from '../start/snapshot-definition.js';

/** A reader of the store: the step's transaction, or the database for a read outside a step. */
export type StoreReader = Database | RuntimeTx;

/**
 * The input of an `agent` task (design-runtime.md, Data Model; ADR-0017): the snapshot, the assignment,
 * the description, a fork's link to its parent's history and, at a conversation's root, the chip of its
 * first message. The snapshot is written here once and only here; the first step makes the session from
 * it when the starter did not.
 */
export const AgentTaskInputSchema = z.object({
  snapshot: RunSnapshotSchema,
  prompt: z.string(),
  description: z.string(),
  forkedFrom: z
    .object({ agentId: z.string().min(1), throughSeq: z.number().int().nonnegative() })
    .optional(),
  record: ChipRecordSchema.optional(),
});
export type SessionInput = z.infer<typeof AgentTaskInputSchema>;

/**
 * The input of an agent task, parsed (run-snapshot.md, «Чтение»): the one way steps, tools and operations
 * read the snapshot and the assignment written at the start.
 */
export function sessionInputOf(input: unknown): SessionInput {
  return AgentTaskInputSchema.parse(input);
}

/** An `agent_sessions` row: the run's name, parent, origin and first-run mark; the snapshot stays in the task input. */
export interface Session {
  readonly taskId: string;
  /** `null` for a root session. */
  readonly parentId: string | null;
  readonly ownerId: string;
  /** The run's name from its snapshot. */
  readonly name: string;
  /** The record the run started from; a root session carries the builtin record `chat`. */
  readonly origin: RunOrigin;
  /** The owner had no earlier session with this record; never set on a root session. */
  readonly firstRun: boolean;
  readonly description: string;
  readonly model: string;
  readonly prompt: string;
  readonly forkedFromTaskId: string | null;
  readonly forkedThroughSeq: number | null;
  readonly turns: number;
  readonly interrupted: boolean;
  readonly closed: boolean;
  readonly lastInputTokens: number | null;
  readonly createdAt: Date;
}

/** The task a session is written for: its place in the tree is copied into the row. */
export interface SessionTask {
  readonly taskId: string;
  readonly ownerId: string;
  /** `null` for a root. */
  readonly parentId: string | null;
  /** The task's own id for a root. */
  readonly rootId: string;
}

/** A root session as its owner lists it: the conversation it is to the employee. */
export interface RootSession {
  readonly rootId: string;
  readonly ownerId: string;
  /** Empty until a title is written. */
  readonly title: string;
  readonly createdAt: Date;
  /** The last change, in milliseconds: the key of the owner's list. */
  readonly updatedAt: Date;
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

type SessionRow = typeof agentSessions.$inferSelect;

function originOf(row: SessionRow): RunOrigin {
  return {
    recordId: row.recordId,
    kind: RecordKindSchema.parse(row.recordKind),
    version: row.recordVersion,
    name: row.recordName,
    author:
      row.authorId === null ? null : { id: row.authorId, name: z.string().parse(row.authorName) },
    builtinKey: row.builtinKey,
    executor: row.executor,
  };
}

function toSession(row: SessionRow): Session {
  return {
    taskId: row.taskId,
    parentId: row.parentId,
    ownerId: row.ownerId,
    name: row.name,
    origin: originOf(row),
    firstRun: row.firstRun,
    description: row.description,
    model: row.model,
    prompt: row.prompt,
    forkedFromTaskId: row.forkedFromTaskId,
    forkedThroughSeq: row.forkedThroughSeq,
    turns: row.turns,
    interrupted: row.interrupted,
    closed: row.closed,
    lastInputTokens: row.lastInputTokens,
    createdAt: row.createdAt,
  };
}

/**
 * The list time is written truncated to milliseconds: the list cursor keeps it in ms, so the order of
 * the rows and the cursor's comparison read the same value.
 */
const NOW_MS = sql<Date>`date_trunc('milliseconds', now())`;

/** A root session's row: `title` and `updated_at` are set on every root and only there. */
const isRoot = isNotNull(agentSessions.updatedAt);

const ownedRoot = (rootId: string, ownerId: string) =>
  and(eq(agentSessions.taskId, rootId), eq(agentSessions.ownerId, ownerId), isRoot);

const ROOT_COLUMNS = {
  rootId: agentSessions.taskId,
  ownerId: agentSessions.ownerId,
  title: agentSessions.title,
  createdAt: agentSessions.createdAt,
  updatedAt: agentSessions.updatedAt,
};

function toRootSession(row: {
  rootId: string;
  ownerId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}): RootSession {
  if (row.title === null || row.updatedAt === null) {
    throw new Error(`Session ${row.rootId} is not a root session`);
  }
  return { ...row, title: row.title, updatedAt: row.updatedAt };
}

/** Whether the owner has a session of this record other than `taskId`. */
async function ranBefore(tx: RuntimeTx, ownerId: string, recordId: string, taskId: string): Promise<boolean> {
  const [row] = await tx
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
 * `agent_sessions` inside the caller's transaction (repository over a transaction): one row per agent,
 * keyed by its runtime task. No function opens a transaction.
 */
export const sessions = {
  /**
   * Creates the session and its `task` entry with `seq` 1 unless the session exists (plan Notes 11):
   * both the starter and the agent's first step call it, and `ON CONFLICT DO NOTHING` keeps their race
   * safe. The name, the model and the origin come from the snapshot, the parent and the root from the
   * task; `first_run` is set when the owner had no earlier session with the record. A root session
   * starts with an empty title and its list time. The session that creates the row of the coordinator
   * of a self-learning workflow also creates its run row (`agent_knowledge_runs`), once per run.
   */
  async ensureSession(tx: RuntimeTx, task: SessionTask, input: SessionInput): Promise<void> {
    const { taskId, ownerId } = task;
    const root = task.parentId === null;
    const { origin } = input.snapshot;
    const firstRun = root ? false : !(await ranBefore(tx, ownerId, origin.recordId, taskId));
    const created = await tx
      .insert(agentSessions)
      .values({
        taskId,
        parentId: task.parentId,
        rootId: task.rootId,
        ownerId,
        ...(root ? { title: '', updatedAt: NOW_MS } : {}),
        name: input.snapshot.name,
        description: input.description,
        model: snapshotDefinition(input.snapshot).model,
        prompt: input.prompt,
        recordId: origin.recordId,
        recordKind: origin.kind,
        recordVersion: origin.version,
        recordName: origin.name,
        authorId: origin.author?.id ?? null,
        authorName: origin.author?.name ?? null,
        builtinKey: origin.builtinKey,
        executor: origin.executor,
        firstRun,
        forkedFromTaskId: input.forkedFrom?.agentId ?? null,
        forkedThroughSeq: input.forkedFrom?.throughSeq ?? null,
      })
      .onConflictDoNothing({ target: agentSessions.taskId })
      .returning({ taskId: agentSessions.taskId });
    if (created.length === 0) return;
    await tx.insert(agentMessages).values({
      taskId,
      seq: TASK_ENTRY_SEQ,
      kind: 'task',
      // The chip of a conversation's first message stays on the root's task (plan Notes 9а).
      content: { text: input.prompt, record: input.record ?? null },
    });
    // A run that learns gets its row with its coordinator session, in this transaction (self-learning KD-2).
    const learning = learningRunOf(input.snapshot);
    if (learning !== null) await insertKnowledgeRun(tx, { runId: taskId, ...learning });
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

  /**
   * How many runs of each record the owner started, for the order of the chat listing (KD-4): only
   * sessions of the record itself — an executor carries its workflow's record id and a fork its
   * source's, so neither counts — and never a root session, which the employee starts by writing.
   */
  async recordCounts(reader: StoreReader, ownerId: string): Promise<Map<string, number>> {
    const rows = await reader
      .select({ recordId: agentSessions.recordId, sessions: count() })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.ownerId, ownerId),
          isNotNull(agentSessions.parentId),
          isNull(agentSessions.executor),
          isNull(agentSessions.forkedFromTaskId),
        ),
      )
      .groupBy(agentSessions.recordId);
    return new Map(rows.map((row) => [row.recordId, row.sessions] as const));
  },

  /** Writes the given fields of the session; an empty patch writes nothing. */
  async update(tx: RuntimeTx, taskId: string, patch: SessionPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await tx.update(agentSessions).set(patch).where(eq(agentSessions.taskId, taskId));
  },

  /** The owner's root session; another owner's and a session that is not a root are as absent as a missing one. */
  async root(reader: StoreReader, rootId: string, ownerId: string): Promise<RootSession | undefined> {
    const [row] = await reader.select(ROOT_COLUMNS).from(agentSessions).where(ownedRoot(rootId, ownerId));
    return row === undefined ? undefined : toRootSession(row);
  },

  /** The owner of a root session, whoever it is; `undefined` when `rootId` names no root session. */
  async rootOwner(reader: StoreReader, rootId: string): Promise<string | undefined> {
    const [row] = await reader
      .select({ ownerId: agentSessions.ownerId })
      .from(agentSessions)
      .where(and(eq(agentSessions.taskId, rootId), isRoot));
    return row?.ownerId;
  },

  /**
   * The owner's root sessions, last changed first (`updated_at DESC, task_id DESC`, the order of
   * `agent_sessions_owner_page_idx`): strictly after `after`, at most `limit`; all of them without either.
   */
  async roots(
    reader: StoreReader,
    ownerId: string,
    page: { readonly after?: RootPosition; readonly limit?: number } = {},
  ): Promise<RootSession[]> {
    const owned = and(eq(agentSessions.ownerId, ownerId), isRoot);
    const { after } = page;
    const query = reader
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
    const rows = await (page.limit === undefined ? query : query.limit(page.limit));
    return rows.map(toRootSession);
  },

  /** `updated_at = now()`: the owner's root session moves to the top of the list. */
  async touchRoot(reader: StoreReader, rootId: string, ownerId: string): Promise<void> {
    await reader.update(agentSessions).set({ updatedAt: NOW_MS }).where(ownedRoot(rootId, ownerId));
  },

  /** Sets the owner's title and moves the root session up; `undefined` for a missing or another owner's one. */
  async renameRoot(
    reader: StoreReader,
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<RootSession | undefined> {
    const [row] = await reader
      .update(agentSessions)
      .set({ title, updatedAt: NOW_MS })
      .where(ownedRoot(rootId, ownerId))
      .returning(ROOT_COLUMNS);
    return row === undefined ? undefined : toRootSession(row);
  },

  /** Writes a generated title only into an empty one; `true` when it was written. */
  async titleRootIfEmpty(reader: StoreReader, rootId: string, ownerId: string, title: string): Promise<boolean> {
    const rows = await reader
      .update(agentSessions)
      .set({ title })
      .where(and(ownedRoot(rootId, ownerId), eq(agentSessions.title, '')))
      .returning({ taskId: agentSessions.taskId });
    return rows.length > 0;
  },
};
