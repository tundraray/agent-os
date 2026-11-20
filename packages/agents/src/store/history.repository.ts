import {
  CALL_RECORD_KINDS,
  type HistoryEntryKind,
  HistoryEntryKindSchema,
  ToolOutcomeSchema,
} from '@agent-os/contracts';
import { agentMessages } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, count, desc, eq, gt, gte, inArray, lte, max, notInArray, sql } from 'drizzle-orm';

import { type HistoryContent, HistoryContentSchemas, type HistoryEntry } from '../history/history.js';
import { START_AGENT_TOOL } from '../tools/builtin/start-agent.js';
import type { StoreReader } from './sessions.repository.js';

/** An entry to append: its kind, its content and, for a `model_answer`, the token ledger row. */
export type NewHistoryEntry = {
  readonly [K in HistoryEntryKind]: {
    readonly kind: K;
    readonly content: HistoryContent<K>;
    readonly modelCallId?: string;
  };
}[HistoryEntryKind];

/** A record of one call (`CALL_RECORD_KINDS`). */
export type CallRecord = Extract<HistoryEntry, { kind: (typeof CALL_RECORD_KINDS)[number] }>;

/** Call records the employee does not read as entries: `history` folds them onto the call's state. */
export const HIDDEN_KINDS = CALL_RECORD_KINDS.filter((kind) => kind !== 'tool_result');

/** An entry a history page shows. */
export type PageEntry = Exclude<HistoryEntry, { kind: (typeof HIDDEN_KINDS)[number] }>;

/** What a read of entries selects. */
const ENTRY_COLUMNS = {
  seq: agentMessages.seq,
  kind: agentMessages.kind,
  content: agentMessages.content,
  createdAt: agentMessages.createdAt,
};

interface EntryRow {
  readonly seq: number;
  readonly kind: string;
  readonly content: unknown;
  readonly createdAt: Date;
}

/** Reads a row back as an entry; the content is checked against the schema of its kind. */
function toEntry(row: EntryRow): HistoryEntry {
  const kind = HistoryEntryKindSchema.parse(row.kind);
  const content = HistoryContentSchemas[kind].parse(row.content);
  // The kind and its content were checked together just above; TypeScript cannot correlate them.
  return { seq: row.seq, kind, createdAt: row.createdAt, content } as HistoryEntry;
}

/**
 * The promoted columns of an entry: the call it is about, and the end time of a result — a stored
 * result always has one (`agent_messages_finished_at_check`).
 */
function promoted(entry: NewHistoryEntry) {
  const finishedAt = entry.kind === 'tool_result' ? entry.content.finishedAt : null;
  return {
    callId: 'callId' in entry.content ? entry.content.callId : null,
    finishedAt: finishedAt === null ? null : new Date(finishedAt),
  };
}

const isResult = eq(agentMessages.kind, 'tool_result');

/**
 * `agent_messages` inside the caller's transaction (repository over a transaction): an append-only
 * history whose `seq` grows within the session (Invariant 5). Tool calls live here too: a call is an
 * item of its `model_answer`, and what happened to it are later call records. No function opens a
 * transaction, and none updates a row.
 */
export const history = {
  /** `seq` of the last entry; 0 for an empty history. */
  async lastSeq(reader: StoreReader, taskId: string): Promise<number> {
    const [last] = await reader
      .select({ seq: max(agentMessages.seq) })
      .from(agentMessages)
      .where(eq(agentMessages.taskId, taskId));
    return last?.seq ?? 0;
  },

  /**
   * Appends the entries in order with `seq` = `max(seq) + 1`, `+ 2`, …: history is written only in a
   * transaction under the task's lock — a step's commit or its `guard` (plan Notes 11) — so no other
   * writer races for the numbers. Returns the appended entries; the caller writes
   * `agents.history_appended` with the last `seq`.
   */
  async append(
    tx: RuntimeTx,
    taskId: string,
    entries: readonly NewHistoryEntry[],
  ): Promise<HistoryEntry[]> {
    if (entries.length === 0) return [];
    const lastSeq = await history.lastSeq(tx, taskId);
    const rows = await tx
      .insert(agentMessages)
      .values(
        entries.map((entry, index) => ({
          taskId,
          seq: lastSeq + index + 1,
          kind: entry.kind,
          content: entry.content,
          modelCallId: entry.modelCallId ?? null,
          ...promoted(entry),
        })),
      )
      .returning(ENTRY_COLUMNS);
    return rows.sort((a, b) => a.seq - b.seq).map(toEntry);
  },

  /**
   * What a step works on: the entries from the last `compaction` on, or all of them before the first
   * one. The model sees nothing earlier (KD-7), and no open call is earlier: a compaction is written
   * only when every call is closed.
   */
  async visible(reader: StoreReader, taskId: string): Promise<HistoryEntry[]> {
    const lastCompaction = sql`coalesce((
      select max(m.seq) from ${agentMessages} m
       where m.task_id = ${taskId} and m.kind = 'compaction'), 0)`;
    const rows = await reader
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), gte(agentMessages.seq, lastCompaction)))
      .orderBy(asc(agentMessages.seq));
    return rows.map(toEntry);
  },

  /** A page for the employee: entries with `seq` greater than `afterSeq`, in order, at most `limit`. */
  async page(
    reader: StoreReader,
    taskId: string,
    afterSeq: number,
    limit: number,
  ): Promise<PageEntry[]> {
    const rows = await reader
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.taskId, taskId),
          gt(agentMessages.seq, afterSeq),
          notInArray(agentMessages.kind, HIDDEN_KINDS),
        ),
      )
      .orderBy(asc(agentMessages.seq))
      .limit(limit);
    // The hidden kinds are filtered out by the query.
    return rows.map(toEntry) as PageEntry[];
  },

  /** Every entry through `throughSeq`, in order: the parent's part of a fork's history (KD-7). */
  async through(reader: StoreReader, taskId: string, throughSeq: number): Promise<HistoryEntry[]> {
    const rows = await reader
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), lte(agentMessages.seq, throughSeq)))
      .orderBy(asc(agentMessages.seq));
    return rows.map(toEntry);
  },

  /** The reports of the agent's children, in order, whatever was compacted since. */
  async childReports(reader: StoreReader, taskId: string): Promise<HistoryContent<'child_report'>[]> {
    const rows = await reader
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), eq(agentMessages.kind, 'child_report')))
      .orderBy(asc(agentMessages.seq));
    return rows.map(toEntry).flatMap((entry) => (entry.kind === 'child_report' ? [entry.content] : []));
  },

  /** The records of the given calls, in order. */
  async callRecords(
    reader: StoreReader,
    taskId: string,
    callIds: readonly string[],
  ): Promise<CallRecord[]> {
    if (callIds.length === 0) return [];
    const rows = await reader
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), inArray(agentMessages.callId, [...callIds])))
      .orderBy(asc(agentMessages.seq));
    // Only call records carry a `call_id` (`agent_messages_call_id_check`).
    return rows.map(toEntry) as CallRecord[];
  },

  /** `seq` of the `model_answer` that requested the call; `undefined` when no answer of the agent did. */
  async answerSeqOf(reader: StoreReader, taskId: string, callId: string): Promise<number | undefined> {
    const [answer] = await reader
      .select({ seq: agentMessages.seq })
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.taskId, taskId),
          eq(agentMessages.kind, 'model_answer'),
          sql`${agentMessages.content} -> 'toolCalls' @> ${JSON.stringify([{ callId }])}::jsonb`,
        ),
      )
      .orderBy(desc(agentMessages.seq))
      .limit(1);
    return answer?.seq;
  },

  /** How many runs of the named executor the coordinator's `start_agent` calls started (KD-5, `run_limit`). */
  async startedCount(tx: RuntimeTx, taskId: string, executor: string): Promise<number> {
    const [row] = await tx
      .select({ started: count() })
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.taskId, taskId),
          isResult,
          sql`${agentMessages.content} ->> 'tool' = ${START_AGENT_TOOL}`,
          sql`${agentMessages.content} ->> 'outcome' = ${ToolOutcomeSchema.enum.success}`,
          sql`${agentMessages.content} -> 'args' ->> 'agent' = ${executor}`,
        ),
      );
    return row?.started ?? 0;
  },

  /** How many tool calls the agent's answers requested: the count of a child's report. */
  async toolCallCount(reader: StoreReader, taskId: string): Promise<number> {
    const [row] = await reader
      .select({
        calls: sql<number>`coalesce(sum(jsonb_array_length(${agentMessages.content} -> 'toolCalls')), 0)::int`,
      })
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), eq(agentMessages.kind, 'model_answer')));
    return row?.calls ?? 0;
  },
};
