import { ToolOutcomeSchema } from '@agent-os/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  lte,
  max,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { Db } from '../db';
import { messages } from '../schema';

/** An entry as a read selects it; the kind and the content are checked by the reader. */
export interface MessageRow {
  readonly seq: number;
  readonly kind: string;
  readonly content: unknown;
  readonly createdAt: Date;
}

/** An entry to append with its promoted column: the call it is about. */
export type NewMessageRow = Pick<
  typeof messages.$inferInsert,
  'conversationId' | 'seq' | 'kind' | 'content' | 'callId'
>;

/** What a read of entries selects. */
const ENTRY_COLUMNS = {
  seq: messages.seq,
  kind: messages.kind,
  content: messages.content,
  createdAt: messages.createdAt,
};

const isResult = eq(messages.kind, 'tool_result');

/**
 * The result of a single call of the tool that ran: a built-in tool with `description` (not a list) that
 * ended with the subagent's answer or its failure — a refusal and an interrupt before it was sent ran nothing.
 */
function isSingleTaskResult(tool: string) {
  return and(
    isResult,
    sql`${messages.content} ->> 'tool' = ${tool}`,
    sql`${messages.content} ->> 'server' is null`,
    sql`${messages.content} -> 'args' -> 'description' is not null`,
    inArray(sql`${messages.content} ->> 'outcome'`, [
      ToolOutcomeSchema.enum.success,
      ToolOutcomeSchema.enum.tool_error,
    ]),
  );
}

/**
 * Drizzle queries of `messages`: an append-only history whose `seq` grows within the session (Invariant 5). Tool calls
 * live here too: a call is an item of its `model_answer`, and what happened to it are later call
 * records. No method opens a transaction, and none updates a row.
 */
export class MessagesRepository {
  constructor(private readonly db: Db) {}

  /** `seq` of the last entry; 0 for an empty history. */
  async lastSeq(taskId: string): Promise<number> {
    const [last] = await this.db.client
      .select({ seq: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, taskId));
    return last?.seq ?? 0;
  }

  /**
   * Copies the entries `fromSeq` … `throughSeq` of one session into another unchanged — the same numbers,
   * kinds, content, calls and times; returns how many were copied.
   */
  async copy(
    fromId: string,
    toId: string,
    fromSeq: number,
    throughSeq: number,
  ): Promise<number> {
    const copied = await this.db.client.insert(messages).select(
      this.db.client
        .select({
          ...getTableColumns(messages),
          conversationId: sql<string>`${toId}::uuid`.as('conversation_id'),
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, fromId),
            gte(messages.seq, fromSeq),
            lte(messages.seq, throughSeq),
          ),
        ),
    );
    return copied.rowCount ?? 0;
  }

  /** Inserts the entries and returns them as read back, in no particular order. */
  insert(rows: readonly NewMessageRow[]): Promise<MessageRow[]> {
    return this.db.client
      .insert(messages)
      .values([...rows])
      .returning(ENTRY_COLUMNS);
  }

  /** The entries from the last `compaction` on, in order, or all of them before the first one. */
  visible(taskId: string): Promise<MessageRow[]> {
    const lastCompaction = sql`coalesce((
      select max(m.seq) from ${messages} m
       where m.conversation_id = ${taskId} and m.kind = 'compaction'), 0)`;
    return this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          gte(messages.seq, lastCompaction),
        ),
      )
      .orderBy(asc(messages.seq));
  }

  /** Entries with `seq` greater than `afterSeq` of any kind but `hiddenKinds`, in order, at most `limit`. */
  page(
    taskId: string,
    afterSeq: number,
    limit: number,
    hiddenKinds: readonly string[],
  ): Promise<MessageRow[]> {
    return this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          gt(messages.seq, afterSeq),
          notInArray(messages.kind, [...hiddenKinds]),
        ),
      )
      .orderBy(asc(messages.seq))
      .limit(limit);
  }

  /** Every entry with `seq` greater than `seq`, in order: what was appended since. */
  after(taskId: string, seq: number): Promise<MessageRow[]> {
    return this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(and(eq(messages.conversationId, taskId), gt(messages.seq, seq)))
      .orderBy(asc(messages.seq));
  }

  /** Every entry through `throughSeq`, in order. */
  through(taskId: string, throughSeq: number): Promise<MessageRow[]> {
    return this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(
        and(eq(messages.conversationId, taskId), lte(messages.seq, throughSeq)),
      )
      .orderBy(asc(messages.seq));
  }

  /**
   * The session's last message — its last `task` or `user_message` entry by `seq` — read from the table, whatever
   * was compacted since; `undefined` for a session without one.
   */
  async lastMessage(taskId: string): Promise<MessageRow | undefined> {
    const [row] = await this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          inArray(messages.kind, ['task', 'user_message']),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(1);
    return row;
  }

  /** The records of the given calls, in order: only call records carry a `call_id`. */
  async callRecords(
    taskId: string,
    callIds: readonly string[],
  ): Promise<MessageRow[]> {
    if (callIds.length === 0) return [];
    return this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          inArray(messages.callId, [...callIds]),
        ),
      )
      .orderBy(asc(messages.seq));
  }

  /** `seq` of the `model_answer` that requested the call; `undefined` when no answer of the agent did. */
  async answerSeqOf(
    taskId: string,
    callId: string,
  ): Promise<number | undefined> {
    const [answer] = await this.db.client
      .select({ seq: messages.seq })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          eq(messages.kind, 'model_answer'),
          sql`${messages.content} -> 'toolCalls' @> ${JSON.stringify([{ callId }])}::jsonb`,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(1);
    return answer?.seq;
  }

  /** How many tool calls the agent's answers requested: the count of a child's report. */
  async toolCallCount(taskId: string): Promise<number> {
    const [row] = await this.db.client
      .select({
        calls: sql<number>`coalesce(sum(jsonb_array_length(${messages.content} -> 'toolCalls')), 0)::int`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          eq(messages.kind, 'model_answer'),
        ),
      );
    return row?.calls ?? 0;
  }

  /** How many calls of the sessions ended (`tool_result`), and how many of them with one of `outcomes`. */
  async toolResultCounts(
    taskIds: readonly string[],
    outcomes: readonly string[],
  ): Promise<{ calls: number; matching: number }> {
    if (taskIds.length === 0) return { calls: 0, matching: 0 };
    const [row] = await this.db.client
      .select({
        calls: sql<number>`count(*)::int`,
        matching: sql<number>`(count(*) filter (where ${inArray(sql`${messages.content} ->> 'outcome'`, [...outcomes])}))::int`,
      })
      .from(messages)
      .where(and(inArray(messages.conversationId, [...taskIds]), isResult));
    return row ?? { calls: 0, matching: 0 };
  }

  /** The text of each session's first `task` entry — its assignment. */
  taskTexts(
    taskIds: readonly string[],
  ): Promise<{ conversationId: string; text: string }[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.client
      .selectDistinctOn([messages.conversationId], {
        conversationId: messages.conversationId,
        text: sql<string>`${messages.content} ->> 'text'`,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, [...taskIds]),
          eq(messages.kind, 'task'),
        ),
      )
      .orderBy(messages.conversationId, asc(messages.seq));
  }

  /**
   * How many single assignments each subagent got from the agent's calls of the tool, whatever was
   * compacted since. List items and refused or interrupted calls do not count.
   */
  singleTaskRuns(
    taskId: string,
    tool: string,
  ): Promise<{ subagent: string; runs: number }[]> {
    const subagent = sql<string>`${messages.content} -> 'args' ->> 'subagentType'`;
    return this.db.client
      .select({ subagent, runs: count() })
      .from(messages)
      .where(and(eq(messages.conversationId, taskId), isSingleTaskResult(tool)))
      .groupBy(subagent);
  }

  /**
   * The subagent task of the last single call of the tool to the named subagent that finished;
   * `undefined` — none yet.
   */
  async lastSingleTask(
    taskId: string,
    tool: string,
    subagent: string,
  ): Promise<string | undefined> {
    const [row] = await this.db.client
      .select({
        childTaskId: sql<string | null>`${messages.content} ->> 'childTaskId'`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          isSingleTaskResult(tool),
          sql`${messages.content} -> 'args' ->> 'subagentType' = ${subagent}`,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(1);
    return row?.childTaskId ?? undefined;
  }
}
