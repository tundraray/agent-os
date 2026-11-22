import { jsonb, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt } from './helpers';
import { agentSessions } from './agent-sessions';

/**
 * Full result of a successful or empty direct MCP call (code-execution KD-5; tool-result-reading R-1, R-4):
 * the one place of the full result, keyed by the call of its session's history, with the known secrets
 * masked.
 */
export const agentToolResults = app.table(
  'agent_tool_results',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    /** The value a script reads with `readResult`. */
    value: jsonb('value').notNull(),
    /** The full text the reading tools page through and search. */
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.callId] })],
);
