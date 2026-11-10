import { type Database, researchAgentMessages } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { asc, eq, sql } from 'drizzle-orm';

/**
 * What a session message is (design-agent-core.md, Data Model): the assignment or the prologue's first message, a model
 * answer, the result of one tool call, or a remark of the code (`no_tool_call`, «last turn: return the result»).
 */
export type SessionMessageKind = 'assignment' | 'prologue' | 'model_answer' | 'tool_result' | 'code_notice';

export interface SessionMessageInput {
  readonly kind: SessionMessageKind;
  readonly content: unknown;
  /** The ledger row of a model answer. */
  readonly llmCallId?: string;
  /** The tool call whose result the message carries. */
  readonly toolCallId?: string;
}

export type SessionMessageRow = typeof researchAgentMessages.$inferSelect;

/** The run a message belongs to. */
export interface SessionOwner {
  readonly runTaskId: string;
  readonly investigationId: string;
}

/**
 * `research_agent_messages` (KD-2, invariant 1): a session is only appended to, its messages numbered from 0 without
 * gaps. Every append runs inside a guarded transaction of the run's own task, which holds that task's row lock to the
 * commit: two writes of one session never interleave, so the next number is the last one plus one, and the primary key
 * (run, number) refuses anything else.
 */
export const sessionRepository = {
  /** Appends `messages` in order and returns their numbers. */
  async append(tx: RuntimeTx, owner: SessionOwner, messages: readonly SessionMessageInput[]): Promise<number[]> {
    if (messages.length === 0) return [];
    const [last] = await tx
      .select({ seq: sql<number | null>`max(${researchAgentMessages.seq})` })
      .from(researchAgentMessages)
      .where(eq(researchAgentMessages.runTaskId, owner.runTaskId));
    const first = (last?.seq ?? -1) + 1;
    const rows = messages.map((message, index) => ({
      runTaskId: owner.runTaskId,
      investigationId: owner.investigationId,
      seq: first + index,
      kind: message.kind,
      content: message.content,
      llmCallId: message.llmCallId ?? null,
      toolCallId: message.toolCallId ?? null,
    }));
    await tx.insert(researchAgentMessages).values(rows);
    return rows.map((row) => row.seq);
  },

  /** The whole session, in order. */
  read(db: Database | RuntimeTx, runTaskId: string): Promise<SessionMessageRow[]> {
    return db
      .select()
      .from(researchAgentMessages)
      .where(eq(researchAgentMessages.runTaskId, runTaskId))
      .orderBy(asc(researchAgentMessages.seq));
  },
};
