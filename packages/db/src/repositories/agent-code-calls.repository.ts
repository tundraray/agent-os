import type { ToolOutcome, ToolRefusalReason } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../database';
import { agentCodeCalls, agentMessages } from '../schema';
import { type FinishedMcpCall, finishedIn, type FinishedWindow } from './finished-window';

/** One call of an agent: its session and the call id its provider gave. */
export interface CallKey {
  readonly taskId: string;
  readonly callId: string;
}

/** One tool call a `run_code` script asked for, written before it goes to its server (KD-6). */
export interface NewCodeCall {
  readonly taskId: string;
  /** `callId` of the `run_code` call. */
  readonly runCallId: string;
  readonly attempt: number;
  /** Number of the call within its attempt. */
  readonly seq: number;
  readonly tool: string;
  /** MCP server id; null for built-in and registered tools. */
  readonly server: string | null;
  readonly args: unknown;
}

/** One call from code: the key of its row. */
export interface CodeCallKey {
  readonly taskId: string;
  readonly runCallId: string;
  readonly attempt: number;
  readonly seq: number;
}

/** How a call from code ends. */
export interface CodeCallEnding {
  readonly outcome: ToolOutcome;
  readonly refusalReason?: ToolRefusalReason;
  readonly finishedAt: Date;
}

function byKey(call: CodeCallKey) {
  return and(
    eq(agentCodeCalls.taskId, call.taskId),
    eq(agentCodeCalls.runCallId, call.runCallId),
    eq(agentCodeCalls.attempt, call.attempt),
    eq(agentCodeCalls.seq, call.seq),
  );
}

/**
 * Drizzle queries of `agent_code_calls` (repository over a transaction): the audit of the calls a script
 * made, one row per request, of the `run_code` call `(task_id, run_call_id)` of its session (KD-6). A row
 * gets at most one outcome (Invariant 4): every closing write is guarded by `outcome is null`.
 */
@Injectable()
export class AgentCodeCallsRepository {
  /** Writes the open row of a call; the caller writes it through the step's `guard`. */
  async open(tx: Transaction, call: NewCodeCall): Promise<void> {
    await tx.insert(agentCodeCalls).values(call);
  }

  /**
   * Closes the row with its outcome outside a step's transaction: one UPDATE, its own short
   * transaction — a record that the call ended or was cancelled, not a new action (Flow 4). `false`
   * when the row was already closed.
   */
  async close(db: Database, call: CodeCallKey, ending: CodeCallEnding): Promise<boolean> {
    const closed = await db
      .update(agentCodeCalls)
      .set({
        outcome: ending.outcome,
        refusalReason: ending.refusalReason ?? null,
        finishedAt: ending.finishedAt,
      })
      .where(and(byKey(call), isNull(agentCodeCalls.outcome)))
      .returning({ seq: agentCodeCalls.seq });
    return closed.length > 0;
  }

  /**
   * The MCP calls scripts of the tasks made, with one of the outcomes, finished in the window, by end
   * time — of each run's latest attempt only: a re-run script repeats its calls, and an earlier attempt
   * would give the same call twice. The latest attempt is the number of the run's `run_attempt` records
   * (a `write` run has none and runs once, as attempt 1).
   */
  async mcpCallsOfLatestAttempts<O extends ToolOutcome>(
    executor: Executor,
    taskIds: readonly string[],
    outcomes: readonly O[],
    window: FinishedWindow,
  ): Promise<FinishedMcpCall<O>[]> {
    const attempts = sql`(
      select count(*) from ${agentMessages}
       where ${agentMessages.taskId} = ${agentCodeCalls.taskId}
         and ${agentMessages.callId} = ${agentCodeCalls.runCallId}
         and ${agentMessages.kind} = 'run_attempt')`;
    const rows = await executor
      .select({
        server: agentCodeCalls.server,
        tool: agentCodeCalls.tool,
        outcome: agentCodeCalls.outcome,
        args: agentCodeCalls.args,
        finishedAt: agentCodeCalls.finishedAt,
      })
      .from(agentCodeCalls)
      .where(
        and(
          inArray(agentCodeCalls.taskId, [...taskIds]),
          eq(agentCodeCalls.attempt, sql`greatest(${attempts}, 1)`),
          isNotNull(agentCodeCalls.server),
          inArray(agentCodeCalls.outcome, [...outcomes]),
          finishedIn(agentCodeCalls.finishedAt, window),
        ),
      )
      .orderBy(
        asc(agentCodeCalls.finishedAt),
        asc(agentCodeCalls.taskId),
        asc(agentCodeCalls.runCallId),
        asc(agentCodeCalls.seq),
      );
    // The query keeps only rows with a server, one of the outcomes and an end time.
    return rows.map((row) => ({
      server: row.server as string,
      tool: row.tool,
      outcome: row.outcome as O,
      args: row.args,
      finishedAt: row.finishedAt as Date,
    }));
  }

  /** Closes every open row of the run, of any attempt, with the given outcome. */
  async closeOpenOfRun(tx: Transaction, run: CallKey, outcome: ToolOutcome): Promise<void> {
    await tx
      .update(agentCodeCalls)
      .set({ outcome, finishedAt: sql`now()` })
      .where(
        and(
          eq(agentCodeCalls.taskId, run.taskId),
          eq(agentCodeCalls.runCallId, run.callId),
          isNull(agentCodeCalls.outcome),
        ),
      );
  }
}
