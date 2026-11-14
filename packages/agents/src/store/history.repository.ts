import { type HistoryEntryKind, HistoryEntryKindSchema } from '@agent-os/contracts';
import { agentMessages } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, desc, eq, gt, lte, max } from 'drizzle-orm';

import { type HistoryContent, HistoryContentSchemas, type HistoryEntry } from '../history/history.js';
import type { StoreReader } from './sessions.repository.js';

/** An entry to append: its kind, its content and, for a `model_answer`, the token ledger row. */
export type NewHistoryEntry = {
  readonly [K in HistoryEntryKind]: {
    readonly kind: K;
    readonly content: HistoryContent<K>;
    readonly modelCallId?: string;
  };
}[HistoryEntryKind];

export type ModelAnswerEntry = Extract<HistoryEntry, { kind: 'model_answer' }>;

type MessageRow = typeof agentMessages.$inferSelect;

/** Reads a row back as an entry; the content is checked against the schema of its kind. */
function toEntry(row: MessageRow): HistoryEntry {
  const kind = HistoryEntryKindSchema.parse(row.kind);
  const content = HistoryContentSchemas[kind].parse(row.content);
  // The kind and its content were checked together just above; TypeScript cannot correlate them.
  return { seq: row.seq, kind, createdAt: row.createdAt, content } as HistoryEntry;
}

/**
 * `agent_messages` inside the caller's transaction (repository over a transaction): an append-only
 * history whose `seq` grows within the session (Invariant 5). No function opens a transaction.
 */
export const history = {
  /**
   * Appends the entries in order with `seq` = `max(seq) + 1`, `+ 2`, …: history is written only in a
   * transaction of a step under the task's lock (plan Notes 11), so no other writer races for the
   * numbers. Returns the appended entries; the caller writes `agents.history_appended` with the last
   * `seq`.
   */
  async append(
    tx: RuntimeTx,
    taskId: string,
    entries: readonly NewHistoryEntry[],
  ): Promise<HistoryEntry[]> {
    if (entries.length === 0) return [];
    const [last] = await tx
      .select({ seq: max(agentMessages.seq) })
      .from(agentMessages)
      .where(eq(agentMessages.taskId, taskId));
    const lastSeq = last?.seq ?? 0;
    const rows = await tx
      .insert(agentMessages)
      .values(
        entries.map((entry, index) => ({
          taskId,
          seq: lastSeq + index + 1,
          kind: entry.kind,
          content: entry.content,
          modelCallId: entry.modelCallId ?? null,
        })),
      )
      .returning();
    return rows.sort((a, b) => a.seq - b.seq).map(toEntry);
  },

  /** Entries with `seq` greater than `afterSeq`, in order, at most `limit`. */
  async list(
    reader: StoreReader,
    taskId: string,
    afterSeq: number,
    limit: number,
  ): Promise<HistoryEntry[]> {
    const rows = await reader
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), gt(agentMessages.seq, afterSeq)))
      .orderBy(asc(agentMessages.seq))
      .limit(limit);
    return rows.map(toEntry);
  },

  /** Every entry through `throughSeq`, in order: the parent's part of a fork's history (KD-7). */
  async listThrough(
    reader: StoreReader,
    taskId: string,
    throughSeq: number,
  ): Promise<HistoryEntry[]> {
    const rows = await reader
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), lte(agentMessages.seq, throughSeq)))
      .orderBy(asc(agentMessages.seq));
    return rows.map(toEntry);
  },

  /** The newest `model_answer` of the session; `undefined` when the model has not answered yet. */
  async lastAnswer(
    reader: StoreReader,
    taskId: string,
  ): Promise<ModelAnswerEntry | undefined> {
    const kind = HistoryEntryKindSchema.enum.model_answer;
    const [row] = await reader
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), eq(agentMessages.kind, kind)))
      .orderBy(desc(agentMessages.seq))
      .limit(1);
    if (row === undefined) return undefined;
    return {
      seq: row.seq,
      kind,
      createdAt: row.createdAt,
      content: HistoryContentSchemas.model_answer.parse(row.content),
    };
  },
};
