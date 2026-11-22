import { Inject, Injectable } from '@nestjs/common';
import { Db } from '../db';
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
 * Drizzle queries of the single `library_settings` row; the
 * migration creates the row, so its absence is a fault.
 */
@Injectable()
export class LibrarySettingsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async read(): Promise<LibrarySettingsRow> {
    const [row] = await this.db.client.select(settingsColumns).from(librarySettings);
    if (row === undefined) throw new Error('library_settings row is missing');
    return row;
  }

  /** Writes the administrator's change with its time; returns the row after it. */
  async write(defaultMaxTurns: number): Promise<LibrarySettingsRow> {
    const [row] = await this.db.client
      .update(librarySettings)
      .set({ defaultMaxTurns, updatedAt: new Date() })
      .returning(settingsColumns);
    if (row === undefined) throw new Error('library_settings row is missing');
    return row;
  }
}
