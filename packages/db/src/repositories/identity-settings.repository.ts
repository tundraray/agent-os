import { Inject, Injectable } from '@nestjs/common';
import { isNull } from 'drizzle-orm';
import { Db } from '../db';
import { identitySettings } from '../schema';
import { sessionLimitColumns } from './identity-columns';

const settingsColumns = {
  ...sessionLimitColumns,
  publicUrl: identitySettings.publicUrl,
  updatedAt: identitySettings.updatedAt,
};

/** The session limits of the single `identity_settings` row. */
export interface SessionLimitsRow {
  idleMinutes: number;
  absoluteMinutes: number;
}

/** The single `identity_settings` row as the sign-in settings read it. */
export interface IdentitySettingsRow extends SessionLimitsRow {
  publicUrl: string | null;
  updatedAt: Date | null;
}

/** The values an administrator writes. */
export type IdentitySettingsChange = Pick<
  IdentitySettingsRow,
  'publicUrl' | 'idleMinutes' | 'absoluteMinutes'
>;

/**
 * Drizzle queries of the single `identity_settings` row; the
 * migration creates the row, so its absence is a fault.
 */
@Injectable()
export class IdentitySettingsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async readSessionLimits(): Promise<SessionLimitsRow> {
    const [row] = await this.db.client
      .select(sessionLimitColumns)
      .from(identitySettings);
    if (row === undefined) throw new Error('identity_settings row is missing');
    return row;
  }

  async read(): Promise<IdentitySettingsRow> {
    const [row] = await this.db.client
      .select(settingsColumns)
      .from(identitySettings);
    if (row === undefined) throw new Error('identity_settings row is missing');
    return row;
  }

  /** Writes the administrator's change with its time; returns the row after it. */
  async write(change: IdentitySettingsChange): Promise<IdentitySettingsRow> {
    const [row] = await this.db.client
      .update(identitySettings)
      .set({ ...change, updatedAt: new Date() })
      .returning(settingsColumns);
    if (row === undefined) throw new Error('identity_settings row is missing');
    return row;
  }

  /** Saves the public address only while none is saved; false when one already was. */
  async savePublicUrlIfUnset(publicUrl: string): Promise<boolean> {
    const saved = await this.db.client
      .update(identitySettings)
      .set({ publicUrl })
      .where(isNull(identitySettings.publicUrl))
      .returning({ publicUrl: identitySettings.publicUrl });
    return saved.length > 0;
  }
}
