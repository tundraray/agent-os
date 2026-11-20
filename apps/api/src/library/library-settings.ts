import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import type {
  LibrarySettings,
  UpdateLibrarySettingsBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import {
  readLibrarySettings,
  writeLibrarySettings,
  type LibrarySettingsRow,
} from './library-settings.repository.js';

const SETTINGS_OBJECT_TYPE = 'library_settings';

function toLibrarySettings(row: LibrarySettingsRow): LibrarySettings {
  return {
    defaultMaxTurns: row.defaultMaxTurns,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * The library's settings in the single `library_settings` row: «Максимум шагов» a new agent or workflow
 * starts with. The editor reads it through `GET /api/library/choices`; a saved record keeps its own value.
 */
@Injectable()
export class LibrarySettingsService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  /** GET /api/admin/library/settings. */
  async get(): Promise<LibrarySettings> {
    return toLibrarySettings(await readLibrarySettings(this.db));
  }

  /**
   * PUT /api/admin/library/settings: the body is already checked against the bounds. Writes
   * `admin_change` on `library_settings`.
   */
  async update(
    actorId: string,
    { defaultMaxTurns }: UpdateLibrarySettingsBody,
  ): Promise<LibrarySettings> {
    const startedAt = Date.now();
    const { before, after } = await this.db.transaction(async (tx) => {
      const previous = await readLibrarySettings(tx);
      const updated = await writeLibrarySettings(tx, defaultMaxTurns, actorId);
      await this.auditLog.record(tx, {
        kind: 'admin_change',
        actor: actorId,
        objectType: SETTINGS_OBJECT_TYPE,
        before: { defaultMaxTurns: previous.defaultMaxTurns },
        after: { defaultMaxTurns: updated.defaultMaxTurns },
        outcome: 'ok',
      });
      return { before: previous, after: updated };
    });
    this.logger.info('library settings updated', {
      actorId,
      objectType: SETTINGS_OBJECT_TYPE,
      before: { defaultMaxTurns: before.defaultMaxTurns },
      after: { defaultMaxTurns: after.defaultMaxTurns },
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return toLibrarySettings(after);
  }
}
