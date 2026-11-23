import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  parseSettingsValue,
  type SettingsKey,
  type SettingsValue,
} from '@agent-os/contracts';
import { Db, SettingsRepository, type SettingsRow } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log';

/** The value of a key, parsed by its schema, with the time and the author of the last administrator's change. */
export interface StoredSettings<K extends SettingsKey> {
  readonly value: SettingsValue<K>;
  /** Null while the defaults of the migration stand. */
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** An administrator's change of a key: the value before it and after it. */
export interface SettingsChange<K extends SettingsKey> {
  readonly before: StoredSettings<K>;
  readonly after: StoredSettings<K>;
}

/** The response of a settings route: the value with the time of the last administrator's change. */
export function settingsResponse<K extends SettingsKey>({
  value,
  updatedAt,
}: StoredSettings<K>): SettingsValue<K> & { updatedAt: string | null } {
  return { ...value, updatedAt: updatedAt?.toISOString() ?? null };
}

function storedOf<K extends SettingsKey>(
  key: K,
  row: SettingsRow,
): StoredSettings<K> {
  return {
    value: parseSettingsValue(key, row.value),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * The one writer of `settings` (data-model design-schema.md KD-3). Every value is parsed by its key's schema of
 * `@agent-os/contracts`, so a stored value outside it is a fault, never a default. An administrator's write and
 * its `admin_change` (object = the key, «было» and «стало») go in the caller's transaction; a rule of a group above
 * the schema is the group's service's, checked before the write in the same transaction. The conditional replace
 * is the service writes' (the first save of the public address, clearing a deleted default model): no audit, the
 * time and the author stay.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly rows: SettingsRepository,
    private readonly auditLog: AuditLog,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async read<K extends SettingsKey>(key: K): Promise<StoredSettings<K>> {
    return storedOf(key, await this.rows.read(key));
  }

  /** Checks the value by the key's schema, replaces the row and writes its `admin_change`, all in one transaction. */
  async write<K extends SettingsKey>(
    key: K,
    value: unknown,
    actorId: string,
  ): Promise<SettingsChange<K>> {
    const startedAt = Date.now();
    const checked = parseSettingsValue(key, value);
    const change = await this.db.transaction(async () => {
      const before = await this.read(key);
      const after = storedOf(
        key,
        await this.rows.write({ key, value: checked, actorId }),
      );
      await this.auditLog.record({
        kind: 'admin_change',
        actor: actorId,
        objectType: key,
        before: before.value,
        after: after.value,
        outcome: 'ok',
      });
      return { before, after };
    });
    this.logger.info('settings updated', {
      actorId,
      key,
      before: change.before.value,
      after: change.after.value,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return change;
  }

  /**
   * Writes `value` only while the key still holds `expected` (read before); false when another write came first.
   * No audit, the time and the author of the last change stay.
   */
  async replaceIf<K extends SettingsKey>(
    key: K,
    expected: SettingsValue<K>,
    value: SettingsValue<K>,
  ): Promise<boolean> {
    const checked = parseSettingsValue(key, value);
    const written = await this.rows.replaceIf({
      key,
      expected,
      value: checked,
    });
    this.logger.info('settings replaced by the service', {
      key,
      before: expected,
      after: checked,
      outcome: written ? 'ok' : 'changed_meanwhile',
    });
    return written;
  }
}
