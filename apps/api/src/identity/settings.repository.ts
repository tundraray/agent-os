import { identitySettings } from '@agent-os/db';
import { isNull } from 'drizzle-orm';
import type { Executor } from '../common/executor.js';
import type { SessionLimits } from './session-lifetime.js';

/** The session limit columns of the single `identity_settings` row, for a select or a join. */
export const sessionLimitColumns = {
  idleMinutes: identitySettings.idleMinutes,
  absoluteMinutes: identitySettings.absoluteMinutes,
};

const settingsColumns = {
  ...sessionLimitColumns,
  publicUrl: identitySettings.publicUrl,
  updatedAt: identitySettings.updatedAt,
};

/** The single `identity_settings` row as the sign-in settings read it. */
export interface SettingsRow {
  publicUrl: string | null;
  idleMinutes: number;
  absoluteMinutes: number;
  updatedAt: Date | null;
}

/** The values an administrator writes. */
export type SettingsChange = Pick<
  SettingsRow,
  'publicUrl' | 'idleMinutes' | 'absoluteMinutes'
>;

/**
 * Drizzle queries of the single `identity_settings` row (repository-over-transaction.md); the
 * migration creates the row, so its absence is a fault.
 */
export async function readSessionLimits(
  executor: Executor,
): Promise<SessionLimits> {
  const [row] = await executor
    .select(sessionLimitColumns)
    .from(identitySettings);
  if (row === undefined) throw new Error('identity_settings row is missing');
  return row;
}

export async function readSettings(executor: Executor): Promise<SettingsRow> {
  const [row] = await executor.select(settingsColumns).from(identitySettings);
  if (row === undefined) throw new Error('identity_settings row is missing');
  return row;
}

/** Writes the administrator's change with who and when; returns the row after it. */
export async function writeSettings(
  executor: Executor,
  change: SettingsChange,
  actorId: string,
): Promise<SettingsRow> {
  const [row] = await executor
    .update(identitySettings)
    .set({ ...change, updatedAt: new Date(), updatedBy: actorId })
    .returning(settingsColumns);
  if (row === undefined) throw new Error('identity_settings row is missing');
  return row;
}

/** Saves the public address only while none is saved; false when one already was. */
export async function savePublicUrlIfUnset(
  executor: Executor,
  publicUrl: string,
): Promise<boolean> {
  const saved = await executor
    .update(identitySettings)
    .set({ publicUrl })
    .where(isNull(identitySettings.publicUrl))
    .returning({ publicUrl: identitySettings.publicUrl });
  return saved.length > 0;
}
