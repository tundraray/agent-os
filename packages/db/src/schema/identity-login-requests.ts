import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { identityProviders } from './identity-providers';

/** One-time sign-in request; the row is deleted at the first return from the provider. */
export const identityLoginRequests = app.table('identity_login_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: text('state').notNull().unique('identity_login_requests_state_key'),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => identityProviders.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  /** PKCE verifier. */
  codeVerifier: text('code_verifier').notNull(),
  /** Web path to return to after sign-in. */
  next: text('next').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
