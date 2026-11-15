import { agentSessions, agentToolResults } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq } from 'drizzle-orm';

import type { StoreReader } from './sessions.repository.js';

/** The full result of a successful direct MCP call, as a value for scripts (code-execution KD-5). */
export interface NewToolResult {
  readonly taskId: string;
  readonly callId: string;
  readonly value: unknown;
}

/** Who reads a full result: the session of the run and its owner. */
export interface ToolResultLookup {
  readonly callId: string;
  readonly taskId: string;
  readonly ownerId: string;
}

/**
 * `agent_tool_results` (repository over a transaction): written in the step's commit together with the
 * closing of the call, read by `run_code` scripts. No function opens a transaction.
 */
export const toolResults = {
  async insert(tx: RuntimeTx, result: NewToolResult): Promise<void> {
    await tx.insert(agentToolResults).values(result);
  },

  /**
   * The value of the call in the run's session, read only when the session belongs to `ownerId`;
   * `undefined` otherwise. Another session's id and a missing id are indistinguishable (AC-04.3).
   */
  async findForRun(reader: StoreReader, lookup: ToolResultLookup): Promise<unknown> {
    const [row] = await reader
      .select({ value: agentToolResults.value })
      .from(agentToolResults)
      .innerJoin(agentSessions, eq(agentSessions.taskId, agentToolResults.taskId))
      .where(
        and(
          eq(agentToolResults.taskId, lookup.taskId),
          eq(agentToolResults.callId, lookup.callId),
          eq(agentSessions.ownerId, lookup.ownerId),
        ),
      );
    return row?.value;
  },
};
