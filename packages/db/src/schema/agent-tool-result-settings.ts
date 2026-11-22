import {
  TOOL_RESULT_PREVIEW_CHARS_DEFAULT,
  TOOL_RESULT_PREVIEW_CHARS_MAX,
  TOOL_RESULT_PREVIEW_CHARS_MIN,
  TOOL_RESULT_READ_MAX_TOKENS_DEFAULT,
  TOOL_RESULT_READ_MAX_TOKENS_MAX,
  TOOL_RESULT_READ_MAX_TOKENS_MIN,
  TOOL_RESULT_STORE_FROM_CHARS_DEFAULT,
  TOOL_RESULT_STORE_FROM_CHARS_MAX,
  TOOL_RESULT_STORE_FROM_CHARS_MIN,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isWithin } from './helpers';

/** The single row of the large tool result settings (tool-result-reading R-5); the migration creates it. */
export const agentToolResultSettings = app.table(
  'agent_tool_result_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    storeFromChars: integer('store_from_chars')
      .notNull()
      .default(TOOL_RESULT_STORE_FROM_CHARS_DEFAULT),
    previewChars: integer('preview_chars')
      .notNull()
      .default(TOOL_RESULT_PREVIEW_CHARS_DEFAULT),
    readMaxTokens: integer('read_max_tokens')
      .notNull()
      .default(TOOL_RESULT_READ_MAX_TOKENS_DEFAULT),
    /** Null while the defaults stand. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('agent_tool_result_settings_single_row_check', sql`${t.id}`),
    check(
      'agent_tool_result_settings_store_from_chars_check',
      isWithin(
        t.storeFromChars,
        TOOL_RESULT_STORE_FROM_CHARS_MIN,
        TOOL_RESULT_STORE_FROM_CHARS_MAX,
      ),
    ),
    check(
      'agent_tool_result_settings_preview_chars_check',
      isWithin(
        t.previewChars,
        TOOL_RESULT_PREVIEW_CHARS_MIN,
        TOOL_RESULT_PREVIEW_CHARS_MAX,
      ),
    ),
    check(
      'agent_tool_result_settings_read_max_tokens_check',
      isWithin(
        t.readMaxTokens,
        TOOL_RESULT_READ_MAX_TOKENS_MIN,
        TOOL_RESULT_READ_MAX_TOKENS_MAX,
      ),
    ),
  ],
);
