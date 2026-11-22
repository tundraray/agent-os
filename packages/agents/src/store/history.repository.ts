import {
  CALL_RECORD_KINDS,
  type HistoryEntryKind,
  HistoryEntryKindSchema,
  type ToolOutcome,
  ToolOutcomeSchema,
} from '@agent-os/contracts';
import { type agentCodeCalls, agentMessages } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  max,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';

import { type HistoryContent, HistoryContentSchemas, type HistoryEntry } from '../history/history';
import { TASK_TOOL } from '../start/snapshot-definition';
import type { StoreReader } from './sessions.repository';

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
 * The result of a single `task` call that ran: a built-in `task` with `description` (not a list) that ended
 * with the subagent's answer or its failure — a refusal and an interrupt before it was sent ran nothing.
 */
const isSingleTaskResult = and(
  isResult,
  sql`${agentMessages.content} ->> 'tool' = ${TASK_TOOL}`,
  sql`${agentMessages.content} ->> 'server' is null`,
  sql`${agentMessages.content} -> 'args' -> 'description' is not null`,
  inArray(sql`${agentMessages.content} ->> 'outcome'`, [ToolOutcomeSchema.enum.success, ToolOutcomeSchema.enum.tool_error]),
);

/** Calls that finished in (`after`, `through`]; `after` null — no lower bound. */
export interface FinishedWindow {
  readonly after: Date | null;
  readonly through: Date;
}

/** `finished_at` within the window, for either table of calls. */
export function finishedIn(
  finishedAt: typeof agentMessages.finishedAt | typeof agentCodeCalls.finishedAt,
  window: FinishedWindow,
): SQL | undefined {
  return and(
    isNotNull(finishedAt),
    lte(finishedAt, window.through),
    window.after === null ? undefined : gt(finishedAt, window.after),
  );
}

/** A finished MCP call of some tasks: what both tables of calls give a reader of many sessions. */
export interface FinishedMcpCall<O extends ToolOutcome> {
  readonly server: string;
  readonly tool: string;
  readonly outcome: O;
  readonly args: unknown;
  readonly finishedAt: Date;
}

/** A text field of a `tool_result`'s content. */
function resultField(name: string): SQL<string | null> {
  return sql<string | null>`${agentMessages.content} ->> ${name}`;
}

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

  /**
   * How many single assignments each subagent got from the deep agent's `task` calls, whatever was compacted
   * since: what its `maxRuns` counts (deep-agents/design-task.md KD-6). List items and refused or interrupted
   * calls do not count.
   */
  async singleTaskRuns(reader: StoreReader, taskId: string): Promise<Map<string, number>> {
    const subagent = sql<string>`${agentMessages.content} -> 'args' ->> 'subagentType'`;
    const rows = await reader
      .select({ subagent, runs: count() })
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), isSingleTaskResult))
      .groupBy(subagent);
    return new Map(rows.map((row) => [row.subagent, row.runs]));
  },

  /**
   * The subagent task of the last single `task` call to the named subagent that finished (KD-6): the final
   * subagent's answer is read through it; `undefined` — none yet.
   */
  async lastSingleTask(reader: StoreReader, taskId: string, subagent: string): Promise<string | undefined> {
    const [row] = await reader
      .select({ childTaskId: resultField('childTaskId') })
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.taskId, taskId),
          isSingleTaskResult,
          sql`${agentMessages.content} -> 'args' ->> 'subagentType' = ${subagent}`,
        ),
      )
      .orderBy(desc(agentMessages.seq))
      .limit(1);
    return row?.childTaskId ?? undefined;
  },

  /**
   * The direct MCP calls of the tasks with one of the outcomes, finished in the window: their
   * `tool_result` entries, read through the promoted `finished_at` (`agent_messages_result_idx`), by end
   * time. Results of one task that ended at the same moment keep the order they were written in, which
   * is the order of their calls.
   */
  async mcpResults<O extends ToolOutcome>(
    reader: StoreReader,
    taskIds: readonly string[],
    outcomes: readonly O[],
    window: FinishedWindow,
  ): Promise<(FinishedMcpCall<O> & { readonly text: string })[]> {
    const server = resultField('server');
    const outcome = resultField('outcome');
    const rows = await reader
      .select({
        server,
        tool: resultField('tool'),
        outcome,
        args: sql<unknown>`${agentMessages.content} -> 'args'`,
        text: resultField('text'),
        finishedAt: agentMessages.finishedAt,
      })
      .from(agentMessages)
      .where(
        and(
          inArray(agentMessages.taskId, [...taskIds]),
          isResult,
          isNotNull(server),
          inArray(outcome, [...outcomes]),
          finishedIn(agentMessages.finishedAt, window),
        ),
      )
      .orderBy(asc(agentMessages.finishedAt), asc(agentMessages.taskId), asc(agentMessages.seq));
    // The query keeps only rows with a server, one of the outcomes and an end time.
    return rows.map((row) => ({
      server: row.server as string,
      tool: row.tool as string,
      outcome: row.outcome as O,
      args: row.args,
      text: row.text ?? '',
      finishedAt: row.finishedAt as Date,
    }));
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
