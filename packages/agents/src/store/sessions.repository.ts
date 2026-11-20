import {
  CHAT_BUILTIN_KEY,
  ChipRecordSchema,
  RecordKindSchema,
  type RunOrigin,
} from '@agent-os/contracts';
import { agentMessages, agentSessions, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, count, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import { RunSnapshotSchema } from '../start/snapshot.js';
import { snapshotDefinition } from '../start/snapshot-definition.js';

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

/** An `agent_sessions` row: the run's name, origin and first-run mark; the snapshot stays in the task input. */
export interface Session {
  readonly taskId: string;
  readonly ownerId: string;
  /** The run's name from its snapshot. */
  readonly name: string;
  /** The record the run started from; `null` for a conversation's root. */
  readonly origin: RunOrigin | null;
  /** The owner had no earlier session with this record. */
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

function originOf(row: SessionRow): RunOrigin | null {
  if (row.recordId === null) return null;
  return {
    recordId: row.recordId,
    kind: RecordKindSchema.parse(row.recordKind),
    version: z.number().int().parse(row.recordVersion),
    name: z.string().parse(row.recordName),
    author:
      row.authorId === null ? null : { id: row.authorId, name: z.string().parse(row.authorName) },
    builtinKey: row.builtinKey,
    executor: row.executor,
  };
}

function toSession(row: SessionRow): Session {
  return {
    taskId: row.taskId,
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
 * The origin the session row keeps (KD-3): the snapshot's, except at a conversation's root — a run of the
 * `chat` record — whose row has none.
 */
function storedOrigin(input: SessionInput): RunOrigin | null {
  const { origin } = input.snapshot;
  return origin.builtinKey === CHAT_BUILTIN_KEY ? null : origin;
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
   * safe. The name, the model and the origin come from the snapshot; `first_run` is set when the owner
   * had no earlier session with the record.
   */
  async ensureSession(
    tx: RuntimeTx,
    taskId: string,
    input: SessionInput,
    ownerId: string,
  ): Promise<void> {
    const origin = storedOrigin(input);
    const firstRun = origin === null ? false : !(await ranBefore(tx, ownerId, origin.recordId, taskId));
    const created = await tx
      .insert(agentSessions)
      .values({
        taskId,
        ownerId,
        name: input.snapshot.name,
        description: input.description,
        model: snapshotDefinition(input.snapshot).model,
        prompt: input.prompt,
        recordId: origin?.recordId ?? null,
        recordKind: origin?.kind ?? null,
        recordVersion: origin?.version ?? null,
        recordName: origin?.name ?? null,
        authorId: origin?.author?.id ?? null,
        authorName: origin?.author?.name ?? null,
        builtinKey: origin?.builtinKey ?? null,
        executor: origin?.executor ?? null,
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
   * source's, so neither counts.
   */
  async recordCounts(reader: StoreReader, ownerId: string): Promise<Map<string, number>> {
    const rows = await reader
      .select({ recordId: agentSessions.recordId, sessions: count() })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.ownerId, ownerId),
          isNotNull(agentSessions.recordId),
          isNull(agentSessions.executor),
          isNull(agentSessions.forkedFromTaskId),
        ),
      )
      .groupBy(agentSessions.recordId);
    return new Map(
      rows.flatMap((row) => (row.recordId === null ? [] : [[row.recordId, row.sessions] as const])),
    );
  },

  /** Writes the given fields of the session; an empty patch writes nothing. */
  async update(tx: RuntimeTx, taskId: string, patch: SessionPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await tx.update(agentSessions).set(patch).where(eq(agentSessions.taskId, taskId));
  },
};
