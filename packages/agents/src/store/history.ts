import {
  CALL_RECORD_KINDS,
  type ChipRecord,
  type HistoryEntryKind,
  HistoryEntryKindSchema,
} from '@agent-os/contracts';
import { type MessageRow, MessagesRepository } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';

import {
  type HistoryContent,
  HistoryContentSchemas,
  type HistoryEntry,
} from '../history/history';

/** An entry to append: its kind and its content. */
export type NewHistoryEntry = {
  readonly [K in HistoryEntryKind]: {
    readonly kind: K;
    readonly content: HistoryContent<K>;
  };
}[HistoryEntryKind];

/** A record of one call (`CALL_RECORD_KINDS`). */
type CallRecord = Extract<
  HistoryEntry,
  { kind: (typeof CALL_RECORD_KINDS)[number] }
>;

/** Call records the employee does not read as entries: `history` folds them onto the call's state. */
const HIDDEN_KINDS = CALL_RECORD_KINDS.filter((kind) => kind !== 'tool_result');

/** An entry a history page shows. */
export type PageEntry = Exclude<
  HistoryEntry,
  { kind: (typeof HIDDEN_KINDS)[number] }
>;

/** Reads a row back as an entry; the content is checked against the schema of its kind. */
function toEntry(row: MessageRow): HistoryEntry {
  const kind = HistoryEntryKindSchema.parse(row.kind);
  const content = HistoryContentSchemas[kind].parse(row.content);
  // The kind and its content were checked together just above; TypeScript cannot correlate them.
  return {
    seq: row.seq,
    kind,
    createdAt: row.createdAt,
    content,
  } as HistoryEntry;
}

/** The promoted column of an entry: the call it is about. */
function promoted(entry: NewHistoryEntry) {
  return { callId: 'callId' in entry.content ? entry.content.callId : null };
}

/**
 * The history of a session as entries, over the queries of `MessagesRepository`, inside the
 * caller's transaction: an entry is written with its promoted column and read back checked against
 * the schema of its kind. Tool calls live here too: a call is an item of its `model_answer`, and what
 * happened to it are later call records. Reads that give no entry — a count, a `seq`, the calls of many
 * sessions — go to the repository directly. No method opens a transaction.
 */
@Injectable()
export class History {
  constructor(
    @Inject(MessagesRepository)
    private readonly rows: MessagesRepository,
  ) {}

  /**
   * Appends the entries in order with `seq` = `max(seq) + 1`, `+ 2`, …: history is written only in a
   * step's commit or its `guard` (plan Notes 11), and an agent runs one step at a time. Returns the appended entries.
   */
  async append(
    taskId: string,
    entries: readonly NewHistoryEntry[],
  ): Promise<HistoryEntry[]> {
    if (entries.length === 0) return [];
    const lastSeq = await this.rows.lastSeq(taskId);
    const rows = await this.rows.insert(
      entries.map((entry, index) => ({
        conversationId: taskId,
        seq: lastSeq + index + 1,
        kind: entry.kind,
        content: entry.content,
        ...promoted(entry),
      })),
    );
    return rows.sort((a, b) => a.seq - b.seq).map(toEntry);
  }

  /**
   * What a step works on: the entries from the last `compaction` on, or all of them before the first
   * one. The model sees nothing earlier (KD-7), and no open call is earlier: a compaction is written
   * only when every call is closed.
   */
  async visible(taskId: string): Promise<HistoryEntry[]> {
    return (await this.rows.visible(taskId)).map(toEntry);
  }

  /** The entries appended after `seq`, in order: what a kept agent takes in after its step's commit. */
  async after(taskId: string, seq: number): Promise<HistoryEntry[]> {
    return (await this.rows.after(taskId, seq)).map(toEntry);
  }

  /** A page for the employee: entries with `seq` greater than `afterSeq`, in order, at most `limit`. */
  async page(
    taskId: string,
    afterSeq: number,
    limit: number,
  ): Promise<PageEntry[]> {
    const rows = await this.rows.page(taskId, afterSeq, limit, HIDDEN_KINDS);
    // The hidden kinds are filtered out by the query.
    return rows.map(toEntry) as PageEntry[];
  }

  /**
   * The session's assignment: the text of its `task` entry, its first own entry (data-model design-agents.md,
   * KD-6). A session without one is broken.
   */
  async taskText(taskId: string): Promise<string> {
    const [first] = await this.through(taskId, 1);
    if (first?.kind !== 'task')
      throw new Error(`Session ${taskId} has no task entry first`);
    return first.content.text;
  }

  /**
   * The chip of the message a tool call answers: of the session's last `task` or `user_message` entry before
   * the `model_answer` that requested the call, whatever was compacted since; `null` — that message carries
   * none, so the chip of an earlier message never reaches a later one.
   */
  async answeredChip(
    taskId: string,
    callId: string,
  ): Promise<ChipRecord | null> {
    const answerSeq = await this.rows.answerSeqOf(taskId, callId);
    if (answerSeq === undefined)
      throw new Error(`No answer of agent ${taskId} requested call ${callId}`);
    const message = (await this.through(taskId, answerSeq)).findLast(
      (
        entry,
      ): entry is Extract<HistoryEntry, { kind: 'task' | 'user_message' }> =>
        entry.kind === 'task' || entry.kind === 'user_message',
    );
    return message?.content.record ?? null;
  }

  /** Every entry through `throughSeq`, in order: the parent's part of a fork's history (KD-7). */
  async through(taskId: string, throughSeq: number): Promise<HistoryEntry[]> {
    return (await this.rows.through(taskId, throughSeq)).map(toEntry);
  }

  /** The records of the given calls, in order. */
  async callRecords(
    taskId: string,
    callIds: readonly string[],
  ): Promise<CallRecord[]> {
    const rows = await this.rows.callRecords(taskId, callIds);
    // Only call records carry a `call_id` (`messages_call_id_check`).
    return rows.map(toEntry) as CallRecord[];
  }
}
