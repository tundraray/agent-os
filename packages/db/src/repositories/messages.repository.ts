import { type ToolOutcome, ToolOutcomeSchema } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
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
import { Db } from '../db';
import { messages } from '../schema';
import {
  type FinishedMcpCall,
  finishedIn,
  type FinishedWindow,
} from './finished-window';

/** An entry as a read selects it; the kind and the content are checked by the reader. */
export interface MessageRow {
  readonly seq: number;
  readonly kind: string;
  readonly content: unknown;
  readonly createdAt: Date;
}

/** An entry to append with its promoted columns: the call it is about and the end time of a result. */
export type NewMessageRow = Pick<
  typeof messages.$inferInsert,
  'conversationId' | 'seq' | 'kind' | 'content' | 'callId' | 'finishedAt'
>;

/** What a read of entries selects. */
const ENTRY_COLUMNS = {
  seq: messages.seq,
  kind: messages.kind,
  content: messages.content,
  createdAt: messages.createdAt,
};

const isResult = eq(messages.kind, 'tool_result');

/** A text field of a `tool_result`'s content. */
function resultField(name: string): SQL<string | null> {
  return sql<string | null>`${messages.content} ->> ${name}`;
}

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
@Injectable()
export class MessagesRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** `seq` of the last entry; 0 for an empty history. */
  async lastSeq(taskId: string): Promise<number> {
    const [last] = await this.db.client
      .select({ seq: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, taskId));
    return last?.seq ?? 0;
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
   * The `tool_sent` entries that name a task of the session's list, in order, whatever was compacted since:
   * only an accepted `task` call writes `taskId` into its `tool_sent`.
   */
  sentForListTask(taskId: string): Promise<MessageRow[]> {
    return this.db.client
      .select(ENTRY_COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, taskId),
          eq(messages.kind, 'tool_sent'),
          sql`${messages.content} ->> 'taskId' is not null`,
        ),
      )
      .orderBy(asc(messages.seq));
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

  /**
   * The direct MCP calls of the tasks with one of the outcomes, finished in the window: their
   * `tool_result` entries, read through the promoted `finished_at` (`messages_result_idx`), by end
   * time. Results of one task that ended at the same moment keep the order they were written in, which
   * is the order of their calls.
   */
  async mcpResults<O extends ToolOutcome>(
    taskIds: readonly string[],
    outcomes: readonly O[],
    window: FinishedWindow,
  ): Promise<(FinishedMcpCall<O> & { readonly text: string })[]> {
    const server = resultField('server');
    const outcome = resultField('outcome');
    const rows = await this.db.client
      .select({
        server,
        tool: resultField('tool'),
        outcome,
        args: sql<unknown>`${messages.content} -> 'args'`,
        text: resultField('text'),
        finishedAt: messages.finishedAt,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, [...taskIds]),
          isResult,
          isNotNull(server),
          inArray(outcome, [...outcomes]),
          finishedIn(messages.finishedAt, window),
        ),
      )
      .orderBy(
        asc(messages.finishedAt),
        asc(messages.conversationId),
        asc(messages.seq),
      );
    // The query keeps only rows with a server, one of the outcomes and an end time.
    return rows.map((row) => ({
      server: row.server as string,
      tool: row.tool as string,
      outcome: row.outcome as O,
      args: row.args,
      text: row.text ?? '',
      finishedAt: row.finishedAt as Date,
    }));
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
