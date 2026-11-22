import { primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { agentMcpServers } from './agent-mcp-servers';

/** Personal credentials of an employee on a server; deleting the server deletes them (AC-13.6). */
export const agentMcpAccounts = app.table(
  'agent_mcp_accounts',
  {
    /** Employee id; text without FK (ADR-0012). */
    ownerId: text('owner_id').notNull(),
    server: text('server')
      .notNull()
      .references(() => agentMcpServers.name, { onDelete: 'cascade' }),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.server] })],
);
