import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { identityUsers } from './identity-users';

/** Session of an employee; its limits are computed from the settings, not stored (KD-2). */
export const identitySessions = app.table(
  'identity_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the session token; the token itself is never stored. */
    tokenHash: text('token_hash')
      .notNull()
      .unique('identity_sessions_token_hash_key'),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Why the session was ended (`account_disabled`, DC-9); null while it is live. */
    endedReason: text('ended_reason'),
  },
  (t) => [index('identity_sessions_user_idx').on(t.userId)],
);
