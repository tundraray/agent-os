import type { ToolOutcome, ToolRefusalReason } from '@agent-os/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { codeCalls } from '../schema';

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
    eq(codeCalls.conversationId, call.taskId),
    eq(codeCalls.runCallId, call.runCallId),
    eq(codeCalls.attempt, call.attempt),
    eq(codeCalls.seq, call.seq),
  );
}

/**
 * Drizzle queries of `code_calls`: the audit of the calls a script
 * made, one row per request, of the `run_code` call `(conversation_id, run_call_id)` of its session (KD-6). A row
 * gets at most one outcome (Invariant 4): every closing write is guarded by `outcome is null`.
 */
export class CodeCallsRepository {
  constructor(private readonly db: Db) {}

  /** Writes the open row of a call; the caller writes it through the step's `guard`. */
  async open(call: NewCodeCall): Promise<void> {
    const { taskId, ...row } = call;
    await this.db.client
      .insert(codeCalls)
      .values({ ...row, conversationId: taskId });
  }

  /**
   * Closes the row with its outcome: one UPDATE — a record that the call ended or was cancelled, not a new action (Flow 4). `false`
   * when the row was already closed.
   */
  async close(call: CodeCallKey, ending: CodeCallEnding): Promise<boolean> {
    const closed = await this.db.client
      .update(codeCalls)
      .set({
        outcome: ending.outcome,
        refusalReason: ending.refusalReason ?? null,
        finishedAt: ending.finishedAt,
      })
      .where(and(byKey(call), isNull(codeCalls.outcome)))
      .returning({ seq: codeCalls.seq });
    return closed.length > 0;
  }

  /** Closes every open row of the run, of any attempt, with the given outcome. */
  async closeOpenOfRun(run: CallKey, outcome: ToolOutcome): Promise<void> {
    await this.db.client
      .update(codeCalls)
      .set({ outcome, finishedAt: sql`now()` })
      .where(
        and(
          eq(codeCalls.conversationId, run.taskId),
          eq(codeCalls.runCallId, run.callId),
          isNull(codeCalls.outcome),
        ),
      );
  }
}
