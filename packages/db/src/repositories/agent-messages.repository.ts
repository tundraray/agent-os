import { type ToolOutcome, ToolOutcomeSchema } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
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
import type { Executor, Transaction } from '../database';
import { agentMessages } from '../schema';
import { type FinishedMcpCall, finishedIn, type FinishedWindow } from './finished-window';

/** An entry as a read selects it; the kind and the content are checked by the reader. */
export interface AgentMessageRow {
  readonly seq: number;
  readonly kind: string;
  readonly content: unknown;
  readonly createdAt: Date;
}

/** An entry to append with its promoted columns: the call it is about and the end time of a result. */
export type NewAgentMessageRow = Pick<
  typeof agentMessages.$inferInsert,
  'taskId' | 'seq' | 'kind' | 'content' | 'modelCallId' | 'callId' | 'finishedAt'
>;

/** What a read of entries selects. */
const ENTRY_COLUMNS = {
  seq: agentMessages.seq,
  kind: agentMessages.kind,
  content: agentMessages.content,
  createdAt: agentMessages.createdAt,
};

const isResult = eq(agentMessages.kind, 'tool_result');

/** A text field of a `tool_result`'s content. */
function resultField(name: string): SQL<string | null> {
  return sql<string | null>`${agentMessages.content} ->> ${name}`;
}

/**
 * The result of a single call of the tool that ran: a built-in tool with `description` (not a list) that
 * ended with the subagent's answer or its failure — a refusal and an interrupt before it was sent ran nothing.
 */
function isSingleTaskResult(tool: string) {
  return and(
    isResult,
    sql`${agentMessages.content} ->> 'tool' = ${tool}`,
    sql`${agentMessages.content} ->> 'server' is null`,
    sql`${agentMessages.content} -> 'args' -> 'description' is not null`,
    inArray(sql`${agentMessages.content} ->> 'outcome'`, [
      ToolOutcomeSchema.enum.success,
      ToolOutcomeSchema.enum.tool_error,
    ]),
  );
}

/**
 * Drizzle queries of `agent_messages` inside the caller's transaction (repository over a
 * transaction): an append-only history whose `seq` grows within the session (Invariant 5). Tool calls
 * live here too: a call is an item of its `model_answer`, and what happened to it are later call
 * records. No method opens a transaction, and none updates a row.
 */
@Injectable()
export class AgentMessagesRepository {
  /** `seq` of the last entry; 0 for an empty history. */
  async lastSeq(executor: Executor, taskId: string): Promise<number> {
    const [last] = await executor
      .select({ seq: max(agentMessages.seq) })
      .from(agentMessages)
      .where(eq(agentMessages.taskId, taskId));
    return last?.seq ?? 0;
  }

  /** Inserts the entries and returns them as read back, in no particular order. */
  insert(tx: Transaction, rows: readonly NewAgentMessageRow[]): Promise<AgentMessageRow[]> {
    return tx
      .insert(agentMessages)
      .values([...rows])
      .returning(ENTRY_COLUMNS);
  }

  /** The entries from the last `compaction` on, in order, or all of them before the first one. */
  visible(executor: Executor, taskId: string): Promise<AgentMessageRow[]> {
    const lastCompaction = sql`coalesce((
      select max(m.seq) from ${agentMessages} m
       where m.task_id = ${taskId} and m.kind = 'compaction'), 0)`;
    return executor
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), gte(agentMessages.seq, lastCompaction)))
      .orderBy(asc(agentMessages.seq));
  }

  /** Entries with `seq` greater than `afterSeq` of any kind but `hiddenKinds`, in order, at most `limit`. */
  page(
    executor: Executor,
    taskId: string,
    afterSeq: number,
    limit: number,
    hiddenKinds: readonly string[],
  ): Promise<AgentMessageRow[]> {
    return executor
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.taskId, taskId),
          gt(agentMessages.seq, afterSeq),
          notInArray(agentMessages.kind, [...hiddenKinds]),
        ),
      )
      .orderBy(asc(agentMessages.seq))
      .limit(limit);
  }

  /** Every entry, in order, whatever was compacted since. */
  all(executor: Executor, taskId: string): Promise<AgentMessageRow[]> {
    return executor
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(eq(agentMessages.taskId, taskId))
      .orderBy(asc(agentMessages.seq));
  }

  /** Every entry with `seq` greater than `seq`, in order: what was appended since. */
  after(executor: Executor, taskId: string, seq: number): Promise<AgentMessageRow[]> {
    return executor
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), gt(agentMessages.seq, seq)))
      .orderBy(asc(agentMessages.seq));
  }

  /** Every entry through `throughSeq`, in order. */
  through(executor: Executor, taskId: string, throughSeq: number): Promise<AgentMessageRow[]> {
    return executor
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), lte(agentMessages.seq, throughSeq)))
      .orderBy(asc(agentMessages.seq));
  }

  /** The records of the given calls, in order: only call records carry a `call_id`. */
  async callRecords(
    executor: Executor,
    taskId: string,
    callIds: readonly string[],
  ): Promise<AgentMessageRow[]> {
    if (callIds.length === 0) return [];
    return executor
      .select(ENTRY_COLUMNS)
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), inArray(agentMessages.callId, [...callIds])))
      .orderBy(asc(agentMessages.seq));
  }

  /** `seq` of the `model_answer` that requested the call; `undefined` when no answer of the agent did. */
  async answerSeqOf(executor: Executor, taskId: string, callId: string): Promise<number | undefined> {
    const [answer] = await executor
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
  }

  /**
   * The direct MCP calls of the tasks with one of the outcomes, finished in the window: their
   * `tool_result` entries, read through the promoted `finished_at` (`agent_messages_result_idx`), by end
   * time. Results of one task that ended at the same moment keep the order they were written in, which
   * is the order of their calls.
   */
  async mcpResults<O extends ToolOutcome>(
    executor: Executor,
    taskIds: readonly string[],
    outcomes: readonly O[],
    window: FinishedWindow,
  ): Promise<(FinishedMcpCall<O> & { readonly text: string })[]> {
    const server = resultField('server');
    const outcome = resultField('outcome');
    const rows = await executor
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
  }

  /** How many tool calls the agent's answers requested: the count of a child's report. */
  async toolCallCount(executor: Executor, taskId: string): Promise<number> {
    const [row] = await executor
      .select({
        calls: sql<number>`coalesce(sum(jsonb_array_length(${agentMessages.content} -> 'toolCalls')), 0)::int`,
      })
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), eq(agentMessages.kind, 'model_answer')));
    return row?.calls ?? 0;
  }

  /**
   * How many single assignments each subagent got from the agent's calls of the tool, whatever was
   * compacted since. List items and refused or interrupted calls do not count.
   */
  async singleTaskRuns(executor: Executor, taskId: string, tool: string): Promise<Map<string, number>> {
    const subagent = sql<string>`${agentMessages.content} -> 'args' ->> 'subagentType'`;
    const rows = await executor
      .select({ subagent, runs: count() })
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, taskId), isSingleTaskResult(tool)))
      .groupBy(subagent);
    return new Map(rows.map((row) => [row.subagent, row.runs]));
  }

  /**
   * The subagent task of the last single call of the tool to the named subagent that finished;
   * `undefined` — none yet.
   */
  async lastSingleTask(
    executor: Executor,
    taskId: string,
    tool: string,
    subagent: string,
  ): Promise<string | undefined> {
    const [row] = await executor
      .select({ childTaskId: sql<string | null>`${agentMessages.content} ->> 'childTaskId'` })
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.taskId, taskId),
          isSingleTaskResult(tool),
          sql`${agentMessages.content} -> 'args' ->> 'subagentType' = ${subagent}`,
        ),
      )
      .orderBy(desc(agentMessages.seq))
      .limit(1);
    return row?.childTaskId ?? undefined;
  }
}
