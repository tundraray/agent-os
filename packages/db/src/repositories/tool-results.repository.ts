import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { conversations, toolResults } from '../schema';

/** The full result of a successful or empty direct MCP call, secrets masked (code-execution KD-5; R-1, R-4). */
export interface StoredToolResult {
  /** The value a script reads with `readResult`. */
  readonly value: unknown;
  /** The full text the reading tools page through and search. */
  readonly text: string;
}

export interface NewToolResult extends StoredToolResult {
  readonly taskId: string;
  readonly callId: string;
}

/** Who reads a full result: the session of the caller and its owner. */
export interface ToolResultLookup {
  readonly callId: string;
  readonly taskId: string;
  readonly ownerId: string;
}

/**
 * Drizzle queries of `tool_results`: a result is written in the step's commit together with the closing of the call, read by
 * `run_code` scripts and the reading tools. No method opens a transaction.
 */
export class ToolResultsRepository {
  constructor(private readonly db: Db) {}

  async insert(result: NewToolResult): Promise<void> {
    const { taskId, ...row } = result;
    await this.db.client
      .insert(toolResults)
      .values({ ...row, conversationId: taskId });
  }

  /**
   * The stored result of the call in the caller's session, read only when the session belongs to
   * `ownerId`; `undefined` otherwise. Another session's id and a missing id are indistinguishable (AC-04.3).
   */
  async findForRun(
    lookup: ToolResultLookup,
  ): Promise<StoredToolResult | undefined> {
    const [row] = await this.db.client
      .select({ value: toolResults.value, text: toolResults.text })
      .from(toolResults)
      .innerJoin(
        conversations,
        eq(conversations.id, toolResults.conversationId),
      )
      .where(
        and(
          eq(toolResults.conversationId, lookup.taskId),
          eq(toolResults.callId, lookup.callId),
          eq(conversations.ownerId, lookup.ownerId),
        ),
      );
    return row;
  }
}
