import {
  ABSOLUTE_MINUTES_DEFAULT,
  ABSOLUTE_MINUTES_MAX,
  ABSOLUTE_MINUTES_MIN,
  IDLE_MINUTES_DEFAULT,
  IDLE_MINUTES_MAX,
  IDLE_MINUTES_MIN,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isWithin } from './helpers';

/** The single row of the part's settings (SignInSettings); the migration creates it. */
export const identitySettings = app.table(
  'identity_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    /** Public address without `/api`; null until saved. */
    publicUrl: text('public_url'),
    idleMinutes: integer('idle_minutes').notNull().default(IDLE_MINUTES_DEFAULT),
    absoluteMinutes: integer('absolute_minutes').notNull().default(ABSOLUTE_MINUTES_DEFAULT),
    /** Null while the defaults stand. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('identity_settings_single_row_check', sql`${t.id}`),
    check(
      'identity_settings_idle_minutes_check',
      isWithin(t.idleMinutes, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX),
    ),
    check(
      'identity_settings_absolute_minutes_check',
      isWithin(t.absoluteMinutes, ABSOLUTE_MINUTES_MIN, ABSOLUTE_MINUTES_MAX),
    ),
    check(
      'identity_settings_idle_not_above_absolute_check',
      sql`${t.idleMinutes} <= ${t.absoluteMinutes}`,
    ),
  ],
);
