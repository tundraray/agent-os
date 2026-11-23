import {
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
} from '@agent-os/contracts';
import {
  check,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf } from './helpers';
import { conversations } from './conversations';

/** Audit of the tool calls a `run_code` script made; the result is seen only by the script (code-execution KD-6). */
export const codeCalls = app.table(
  'code_calls',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** `callId` of the `run_code` call in the session's history. */
    runCallId: text('run_call_id').notNull(),
    attempt: integer('attempt').notNull(),
    /** Number of the call within its attempt. */
    seq: integer('seq').notNull(),
    tool: text('tool').notNull(),
    /** MCP server id; null for built-in and registered tools. */
    server: text('server'),
    args: jsonb('args').notNull(),
    outcome: text('outcome'),
    refusalReason: text('refusal_reason'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.runCallId, t.attempt, t.seq] }),
    check(
      'code_calls_outcome_check',
      isOneOf(t.outcome, ToolOutcomeSchema.options),
    ),
    check(
      'code_calls_refusal_reason_check',
      isOneOf(t.refusalReason, ToolRefusalReasonSchema.options),
    ),
  ],
);
