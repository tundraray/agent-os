import { identitySettings } from '@agent-os/db';
import type { SessionLimits } from './session-lifetime.js';
import type { Executor } from './users.repository.js';

/** The session limit columns of the single `identity_settings` row, for a select or a join. */
export const sessionLimitColumns = {
  idleMinutes: identitySettings.idleMinutes,
  absoluteMinutes: identitySettings.absoluteMinutes,
};

/** The current session limits (KD-2); the migration creates the row, so its absence is a fault. */
export async function readSessionLimits(executor: Executor): Promise<SessionLimits> {
  const [row] = await executor.select(sessionLimitColumns).from(identitySettings);
  if (row === undefined) throw new Error('identity_settings row is missing');
  return row;
}
