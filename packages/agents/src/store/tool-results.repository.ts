import { agentSessions, agentToolResultSettings, agentToolResults } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq } from 'drizzle-orm';

import type { StoreReader } from './sessions.repository';

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

/** The single `agent_tool_result_settings` row (R-5). */
export interface ToolResultSettingsRow {
  readonly storeFromChars: number;
  readonly previewChars: number;
  readonly readMaxTokens: number;
  /** `null` while the defaults stand. */
  readonly updatedAt: Date | null;
}

/** The settings before and after a write: the `admin_change` audit is built from them. */
export interface ToolResultSettingsRowChange {
  readonly before: ToolResultSettingsRow;
  readonly after: ToolResultSettingsRow;
}

const settingsColumns = {
  storeFromChars: agentToolResultSettings.storeFromChars,
  previewChars: agentToolResultSettings.previewChars,
  readMaxTokens: agentToolResultSettings.readMaxTokens,
  updatedAt: agentToolResultSettings.updatedAt,
};

/**
 * `agent_tool_results` and `agent_tool_result_settings` (repository over a transaction): a result is
 * written in the step's commit together with the closing of the call, read by `run_code` scripts and the
 * reading tools. No function opens a transaction.
 */
export const toolResults = {
  async insert(tx: RuntimeTx, result: NewToolResult): Promise<void> {
    await tx.insert(agentToolResults).values(result);
  },

  /**
   * The stored result of the call in the caller's session, read only when the session belongs to
   * `ownerId`; `undefined` otherwise. Another session's id and a missing id are indistinguishable (AC-04.3).
   */
  async findForRun(reader: StoreReader, lookup: ToolResultLookup): Promise<StoredToolResult | undefined> {
    const [row] = await reader
      .select({ value: agentToolResults.value, text: agentToolResults.text })
      .from(agentToolResults)
      .innerJoin(agentSessions, eq(agentSessions.taskId, agentToolResults.taskId))
      .where(
        and(
          eq(agentToolResults.taskId, lookup.taskId),
          eq(agentToolResults.callId, lookup.callId),
          eq(agentSessions.ownerId, lookup.ownerId),
        ),
      );
    return row;
  },

  /** The settings row, read anew on every use (settings-row.md); the migration creates it. */
  async readSettings(reader: StoreReader): Promise<ToolResultSettingsRow> {
    const [row] = await reader.select(settingsColumns).from(agentToolResultSettings);
    if (row === undefined) throw new Error('agent_tool_result_settings row is missing');
    return row;
  },

  /** Locks the row and writes the administrator's change with its time; the next MCP call reads it. */
  async writeSettings(
    tx: RuntimeTx,
    values: Omit<ToolResultSettingsRow, 'updatedAt'>,
  ): Promise<ToolResultSettingsRowChange> {
    const [before] = await tx.select(settingsColumns).from(agentToolResultSettings).for('update');
    if (before === undefined) throw new Error('agent_tool_result_settings row is missing');
    const [after] = await tx
      .update(agentToolResultSettings)
      .set({
        storeFromChars: values.storeFromChars,
        previewChars: values.previewChars,
        readMaxTokens: values.readMaxTokens,
        updatedAt: new Date(),
      })
      .returning(settingsColumns);
    if (after === undefined) throw new Error('agent_tool_result_settings row is missing');
    return { before, after };
  },
};
