import {
  type ToolOutcome,
  ToolOutcomeSchema,
  type ToolRefusalReason,
  ToolCallStateSchema,
} from '@agent-os/contracts';
import { agentToolCalls } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';

import type { StoreReader } from './sessions.repository.js';

export type ToolCallRow = typeof agentToolCalls.$inferSelect;

/** A call of a model answer, written `requested` in the transaction that writes the answer. */
export interface NewToolCall {
  readonly taskId: string;
  readonly callId: string;
  /** `seq` of the `model_answer` that requested the call. */
  readonly answerSeq: number;
  /** Position of the call within its answer. */
  readonly position: number;
  readonly tool: string;
  /** MCP server id; null for built-in and registered tools. */
  readonly server: string | null;
  readonly args: unknown;
}

/** One call of an agent: the key of its row. */
export interface ToolCallKey {
  readonly taskId: string;
  readonly callId: string;
}

/** How a call ends; the times default to the moment of the write. */
export interface ToolCallEnding {
  readonly outcome: ToolOutcome;
  readonly refusalReason?: ToolRefusalReason;
  readonly resultText?: string;
  /** Agent started by `start_agent`. */
  readonly childTaskId?: string;
  /** When the call went to its tool; kept when the row already has it (`sending`). */
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
}

/** Name of the built-in tool whose successful calls count toward `limits.agents`. */
const START_AGENT_TOOL = 'start_agent';

const { requested, awaiting_confirmation: awaiting, sending, done } = ToolCallStateSchema.enum;

function byKey(call: ToolCallKey) {
  return and(eq(agentToolCalls.taskId, call.taskId), eq(agentToolCalls.callId, call.callId));
}

/**
 * `agent_tool_calls` inside the caller's transaction (repository over a transaction): one row per call,
 * the audit record of the call (business constraint 3). Every state change is a guarded write — it
 * names the states it moves from, so a closed call is never moved again (Invariants 1, 2). No function
 * opens a transaction.
 */
export const toolCalls = {
  /** Writes the calls of one answer as `requested`. */
  async insertRequested(
    tx: RuntimeTx,
    calls: readonly NewToolCall[],
  ): Promise<ToolCallRow[]> {
    if (calls.length === 0) return [];
    return tx
      .insert(agentToolCalls)
      .values(calls.map((call) => ({ ...call, state: requested })))
      .returning();
  },

  /** The calls of the agent that are not `done`, by answer and position. */
  open(reader: StoreReader, taskId: string): Promise<ToolCallRow[]> {
    return reader
      .select()
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.taskId, taskId), ne(agentToolCalls.state, done)))
      .orderBy(asc(agentToolCalls.answerSeq), asc(agentToolCalls.position));
  },

  /** `requested` → `awaiting_confirmation`; `undefined` when the call was not `requested`. */
  async markAwaiting(tx: RuntimeTx, call: ToolCallKey): Promise<ToolCallRow | undefined> {
    const [moved] = await tx
      .update(agentToolCalls)
      .set({ state: awaiting })
      .where(and(byKey(call), eq(agentToolCalls.state, requested)))
      .returning();
    return moved;
  },

  /**
   * `awaiting_confirmation` → `sending`: the intent written before the confirmed call goes out (KD-4,
   * Invariant 2). `args` replaces the arguments when the employee edited them. `undefined` when the
   * call was not awaiting confirmation — then it must not be sent.
   */
  async markSending(
    tx: RuntimeTx,
    call: ToolCallKey & { readonly args?: unknown },
  ): Promise<ToolCallRow | undefined> {
    const [moved] = await tx
      .update(agentToolCalls)
      .set({
        state: sending,
        startedAt: sql`now()`,
        ...(call.args === undefined ? {} : { args: call.args }),
      })
      .where(and(byKey(call), eq(agentToolCalls.state, awaiting)))
      .returning();
    return moved;
  },

  /**
   * Closes the call with its outcome, from any state but `done` (Invariant 1). A second `close` of the
   * same call changes nothing and returns `undefined`.
   */
  async close(
    tx: RuntimeTx,
    call: ToolCallKey,
    ending: ToolCallEnding,
  ): Promise<ToolCallRow | undefined> {
    const [closed] = await tx
      .update(agentToolCalls)
      .set({
        state: done,
        outcome: ending.outcome,
        refusalReason: ending.refusalReason ?? null,
        resultText: ending.resultText ?? null,
        childTaskId: ending.childTaskId ?? null,
        startedAt: sql`coalesce(${agentToolCalls.startedAt}, ${ending.startedAt ?? sql`now()`})`,
        finishedAt: ending.finishedAt ?? sql`now()`,
      })
      .where(and(byKey(call), ne(agentToolCalls.state, done)))
      .returning();
    return closed;
  },

  /** How many children of the given definition the agent's `start_agent` calls started. */
  async startedCount(tx: RuntimeTx, taskId: string, agentName: string): Promise<number> {
    const [row] = await tx
      .select({ started: count() })
      .from(agentToolCalls)
      .where(
        and(
          eq(agentToolCalls.taskId, taskId),
          eq(agentToolCalls.tool, START_AGENT_TOOL),
          eq(agentToolCalls.outcome, ToolOutcomeSchema.enum.success),
          sql`${agentToolCalls.args} ->> 'agent' = ${agentName}`,
        ),
      );
    return row?.started ?? 0;
  },

  /** How many tool calls the agent made: the count of a child's report. */
  async countFor(reader: StoreReader, taskId: string): Promise<number> {
    const [row] = await reader
      .select({ calls: count() })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.taskId, taskId));
    return row?.calls ?? 0;
  },

  /** The agents with a call awaiting confirmation (plan Notes 7). */
  async awaitingSessions(reader: StoreReader): Promise<string[]> {
    const rows = await reader
      .selectDistinct({ taskId: agentToolCalls.taskId })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.state, awaiting));
    return rows.map((row) => row.taskId);
  },
};
