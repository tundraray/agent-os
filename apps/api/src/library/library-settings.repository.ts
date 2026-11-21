import { librarySettings } from '@agent-os/db';
import type { Executor } from '../common/executor';

const settingsColumns = {
  defaultMaxTurns: librarySettings.defaultMaxTurns,
  updatedAt: librarySettings.updatedAt,
};

/** The single `library_settings` row. */
export interface LibrarySettingsRow {
  defaultMaxTurns: number;
  updatedAt: Date | null;
}

/**
 * Drizzle queries of the single `library_settings` row (repository-over-transaction.md); the
 * migration creates the row, so its absence is a fault.
 */
export async function readLibrarySettings(
  executor: Executor,
): Promise<LibrarySettingsRow> {
  const [row] = await executor.select(settingsColumns).from(librarySettings);
  if (row === undefined) throw new Error('library_settings row is missing');
  return row;
}

/** Writes the administrator's change with its time; returns the row after it. */
export async function writeLibrarySettings(
  executor: Executor,
  defaultMaxTurns: number,
): Promise<LibrarySettingsRow> {
  const [row] = await executor
    .update(librarySettings)
    .set({ defaultMaxTurns, updatedAt: new Date() })
    .returning(settingsColumns);
  if (row === undefined) throw new Error('library_settings row is missing');
  return row;
}
