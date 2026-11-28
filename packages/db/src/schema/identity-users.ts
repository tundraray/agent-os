import {
  LanguageSchema,
  NotificationLevelSchema,
  ThemeIdSchema,
  UserStatusSchema,
} from '@agent-os/contracts';
import {
  boolean,
  check,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';

export const identityUsers = app.table(
  'identity_users',
  {
    /** Issued by the server, never taken from a provider (Invariant 3). */
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** Empty string when there is no name. */
    name: text('name').notNull().default(''),
    /** Login of a local account; null for provider-only accounts. */
    login: text('login'),
    /** argon2id hash with its parameters; null for provider-only accounts. */
    passwordHash: text('password_hash'),
    status: text('status').notNull().default(UserStatusSchema.enum.active),
    /** Personal admin right, besides admin roles. */
    isAdmin: boolean('is_admin').notNull().default(false),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    /** The chosen interface language; null while the employee has not chosen one (i18n KD-4). */
    language: text('language'),
    /** The employee's own colour theme; null — as in the organisation (theming design-preference.md, KD-1). */
    theme: text('theme'),
    /** The employee's default notification level (live-feed design-server.md, KD-7). */
    notificationLevel: text('notification_level')
      .notNull()
      .default(NotificationLevelSchema.enum.all),
    /** The employee's personal instruction, read by every step of their tasks; empty — none (agent-guidance KD-4). */
    instructions: text('instructions').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('identity_users_email_idx').on(t.email),
    uniqueIndex('identity_users_login_idx').on(t.login),
    check(
      'identity_users_status_check',
      isOneOf(t.status, UserStatusSchema.options),
    ),
    check(
      'identity_users_language_check',
      isOneOf(t.language, LanguageSchema.options),
    ),
    check(
      'identity_users_theme_check',
      isOneOf(t.theme, ThemeIdSchema.options),
    ),
    check(
      'identity_users_notification_level_check',
      isOneOf(t.notificationLevel, NotificationLevelSchema.options),
    ),
  ],
);
