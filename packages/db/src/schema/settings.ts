import { SettingsKeySchema } from '@agent-os/contracts';
import { check, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf } from './helpers';
import { identityUsers } from './identity-users';

/**
 * One row per group of settings (data-model design-schema.md KD-3): the value is checked by its key's schema in
 * `@agent-os/contracts`, the migration of built-in rows creates every key's row with its defaults.
 */
export const settings = app.table(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    /** Null while the defaults of the migration stand. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** The administrator of the last change; null while the defaults stand. */
    updatedBy: uuid('updated_by').references(() => identityUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check('settings_key_check', isOneOf(t.key, SettingsKeySchema.options)),
  ],
);
