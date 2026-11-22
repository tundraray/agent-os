import {
  RECORD_MAX_TURNS_DEFAULT,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isWithin } from './helpers';

/** The single row of the library's settings (LibrarySettings); the migration creates it. */
export const librarySettings = app.table(
  'library_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    /** «Максимум шагов» a new agent or deep agent starts with; each record may change its own. */
    defaultMaxTurns: integer('default_max_turns')
      .notNull()
      .default(RECORD_MAX_TURNS_DEFAULT),
    /** Null while the default stands. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('library_settings_single_row_check', sql`${t.id}`),
    check(
      'library_settings_default_max_turns_check',
      isWithin(t.defaultMaxTurns, RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX),
    ),
  ],
);
