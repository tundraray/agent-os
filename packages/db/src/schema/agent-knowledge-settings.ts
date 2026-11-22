import {
  KNOWLEDGE_LIMIT_TOKENS_DEFAULT,
  KNOWLEDGE_LIMIT_TOKENS_MAX,
  KNOWLEDGE_LIMIT_TOKENS_MIN,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isWithin } from './helpers';

/** The single row of the knowledge settings (KnowledgeSettings); the migration creates it. */
export const agentKnowledgeSettings = app.table(
  'agent_knowledge_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    limitTokens: integer('limit_tokens').notNull().default(KNOWLEDGE_LIMIT_TOKENS_DEFAULT),
    lessonsEnabled: boolean('lessons_enabled').notNull().default(true),
    /** Null while the defaults stand. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('agent_knowledge_settings_single_row_check', sql`${t.id}`),
    check(
      'agent_knowledge_settings_limit_tokens_check',
      isWithin(t.limitTokens, KNOWLEDGE_LIMIT_TOKENS_MIN, KNOWLEDGE_LIMIT_TOKENS_MAX),
    ),
  ],
);
