import type { Logger } from '@agent-os/common';
import type { ToolResultSettings } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';

import { type ToolResultSettingsRow, toolResults } from '../store/tool-results.repository';

export interface ToolResultSettingsUpdate {
  /** The administrator, named in the log. */
  readonly actorId: string;
  /** Checked by `UpdateToolResultSettingsBodySchema` before the call; the CHECK is the last line. */
  readonly storeFromChars: number;
  readonly previewChars: number;
  readonly readMaxTokens: number;
}

/** The settings before and after an update: `apps/api` writes its `admin_change` from them. */
export interface ToolResultSettingsChange {
  readonly before: ToolResultSettings;
  readonly after: ToolResultSettings;
}

/**
 * The settings of large tool results (tool-result-reading R-5). They decide nothing about who may call
 * them — the route is admin-only. The runner and the reading tools read the row on every call, so a change
 * takes effect on the next MCP call without a restart.
 */
export interface AgentsToolResults {
  settings(): Promise<ToolResultSettings>;
  updateSettings(update: ToolResultSettingsUpdate): Promise<ToolResultSettingsChange>;
}

export interface AgentsToolResultsDeps {
  readonly database: Database;
  readonly logger: Logger;
}

export function createAgentsToolResults(deps: AgentsToolResultsDeps): AgentsToolResults {
  const { database } = deps;
  const logger = deps.logger.child({ service: 'agents.tool-results' });

  return {
    async settings() {
      return settingsView(await toolResults.readSettings(database));
    },

    async updateSettings({ actorId, storeFromChars, previewChars, readMaxTokens }) {
      const startedAt = Date.now();
      const change = await database.transaction((tx) =>
        toolResults.writeSettings(tx, { storeFromChars, previewChars, readMaxTokens }),
      );
      const before = settingsView(change.before);
      const after = settingsView(change.after);
      logger.info('tool result settings changed', {
        actorId,
        before: valuesOf(before),
        after: valuesOf(after),
        durationMs: Date.now() - startedAt,
      });
      return { before, after };
    },
  };
}

function settingsView(row: ToolResultSettingsRow): ToolResultSettings {
  return {
    storeFromChars: row.storeFromChars,
    previewChars: row.previewChars,
    readMaxTokens: row.readMaxTokens,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function valuesOf(settings: ToolResultSettings) {
  return {
    storeFromChars: settings.storeFromChars,
    previewChars: settings.previewChars,
    readMaxTokens: settings.readMaxTokens,
  };
}
