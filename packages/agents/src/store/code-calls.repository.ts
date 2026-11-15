import {
  RunCodeArgsSchema,
  type ToolOutcome,
  ToolOutcomeSchema,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { agentCodeCalls, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { ToolCallKey } from './tool-calls.repository.js';

/** One tool call a `run_code` script asked for, written before it goes to its server (KD-6). */
export interface NewCodeCall {
  readonly taskId: string;
  /** `callId` of the `run_code` row. */
  readonly runCallId: string;
  readonly attempt: number;
  /** Number of the call within its attempt. */
  readonly seq: number;
  readonly tool: string;
  /** MCP server id; null for built-in and registered tools. */
  readonly server: string | null;
  readonly args: unknown;
  readonly startedAt: Date;
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

const RunClassSchema = RunCodeArgsSchema.pick({ class: true });

/**
 * The outcome of a call from code the run did not close itself (Invariant 4): a `write` run's calls
 * may have reached their server — «unknown»; a `read` run's are «interrupted». Arguments that are not
 * a `run_code` class count as `read`: such a run never started.
 */
export function interruptedRunOutcome(runArgs: unknown): ToolOutcome {
  const parsed = RunClassSchema.safeParse(runArgs);
  return parsed.success && parsed.data.class === 'write'
    ? ToolOutcomeSchema.enum.unknown
    : ToolOutcomeSchema.enum.interrupted;
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
 * `agent_code_calls` (repository over a transaction): the audit of the calls a script made, one row per
 * request, linked to its `run_code` row (KD-6). A row gets at most one outcome (Invariant 4): every
 * closing write is guarded by `outcome is null`.
 */
export const codeCalls = {
  /** Writes the open row of a call; the caller writes it through the step's `guard`. */
  async open(tx: RuntimeTx, call: NewCodeCall): Promise<void> {
    await tx.insert(agentCodeCalls).values(call);
  },

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
  },

  /** Closes every open row of the run, of any attempt, with the given outcome. */
  async closeOpenOfRun(tx: RuntimeTx, run: ToolCallKey, outcome: ToolOutcome): Promise<void> {
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
  },
};
