import { primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { identityUsers } from './identity-users';
import { mcpServers } from './mcp-servers';

/** Personal credentials of an employee on a server; deleting the server deletes them (AC-13.6). */
export const mcpAccounts = app.table(
  'mcp_accounts',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    server: text('server')
      .notNull()
      .references(() => mcpServers.name, { onDelete: 'cascade' }),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.server] })],
);
