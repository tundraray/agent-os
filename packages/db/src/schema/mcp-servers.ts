import { McpServerModeSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';

export const mcpServers = app.table(
  'mcp_servers',
  {
    /** Never changes after registration: tool names and call history carry it. */
    name: text('name').primaryKey(),
    url: text('url').notNull(),
    mode: text('mode').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** Tools as the tool set is built from them without network; null until first listed. */
    tools: jsonb('tools'),
    /** Set exactly for mode `shared`. */
    sharedToken: text('shared_token'),
    /** Authorization server metadata found at registration (issuer and endpoints). */
    oauthServer: jsonb('oauth_server'),
    oauthClientId: text('oauth_client_id'),
    /** Null when the authorization server issued no secret. */
    oauthClientSecret: text('oauth_client_secret'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'mcp_servers_mode_check',
      isOneOf(t.mode, McpServerModeSchema.options),
    ),
    check(
      'mcp_servers_shared_token_check',
      sql`(${t.mode} = ${literal(McpServerModeSchema.enum.shared)}) = (${t.sharedToken} is not null)`,
    ),
    /** Invariant 2: an enabled server always has its tool list. */
    check(
      'mcp_servers_enabled_tools_check',
      sql`not ${t.enabled} or ${t.tools} is not null`,
    ),
    check(
      'mcp_servers_oauth_client_check',
      sql`${t.mode} <> ${literal(McpServerModeSchema.enum.oauth)} or ${t.oauthClientId} is not null`,
    ),
  ],
);
