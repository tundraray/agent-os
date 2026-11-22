import type { Logger } from '@agent-os/common';
import type { ToolResultSettings } from '@agent-os/contracts';
import { AgentToolResultsRepository, Db, type ToolResultSettingsRow } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';

import { AGENTS_LOGGER } from '../agents.tokens';

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
@Injectable()
export class AgentsToolResults {
  private readonly logger: Logger;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AgentToolResultsRepository) private readonly toolResultRows: AgentToolResultsRepository,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.tool-results' });
  }

  async settings(): Promise<ToolResultSettings> {
    return settingsView(await this.toolResultRows.readSettings());
  }

  async updateSettings({
    actorId,
    storeFromChars,
    previewChars,
    readMaxTokens,
  }: ToolResultSettingsUpdate): Promise<ToolResultSettingsChange> {
    const startedAt = Date.now();
    const change = await this.db.transaction(async () =>
      this.toolResultRows.writeSettings({ storeFromChars, previewChars, readMaxTokens }),
    );
    const before = settingsView(change.before);
    const after = settingsView(change.after);
    this.logger.info('tool result settings changed', {
      actorId,
      before: valuesOf(before),
      after: valuesOf(after),
      durationMs: Date.now() - startedAt,
    });
    return { before, after };
  }
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
