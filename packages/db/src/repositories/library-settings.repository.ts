import { Injectable } from '@nestjs/common';
import type { Executor } from '../database';
import { librarySettings } from '../schema';

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
 * Drizzle queries of the single `library_settings` row (repository over a transaction); the
 * migration creates the row, so its absence is a fault.
 */
@Injectable()
export class LibrarySettingsRepository {
  async read(executor: Executor): Promise<LibrarySettingsRow> {
    const [row] = await executor.select(settingsColumns).from(librarySettings);
    if (row === undefined) throw new Error('library_settings row is missing');
    return row;
  }

  /** Writes the administrator's change with its time; returns the row after it. */
  async write(executor: Executor, defaultMaxTurns: number): Promise<LibrarySettingsRow> {
    const [row] = await executor
      .update(librarySettings)
      .set({ defaultMaxTurns, updatedAt: new Date() })
      .returning(settingsColumns);
    if (row === undefined) throw new Error('library_settings row is missing');
    return row;
  }
}
