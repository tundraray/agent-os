import {
  LastExtractionReasonSchema,
  LastExtractionStatusSchema,
} from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf } from './helpers';
import { agentSessions } from './agent-sessions';

/**
 * A run that learns (KD-2, KD-3): written with the coordinator session; deleting the conversation
 * deletes it. The deep agent has no FK here: the row only answers «which deep agent».
 */
export const agentKnowledgeRuns = app.table(
  'agent_knowledge_runs',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    recordId: uuid('record_id').notNull(),
    /** Servers of the whole team: tells a round whether a lesson's tool is alive. */
    servers: jsonb('servers').notNull(),
    /** Calls finished up to this moment are extracted; only moves forward. Null — from the start. */
    extractedUpTo: timestamp('extracted_up_to', { withTimezone: true }),
    /** Extraction task in progress (Invariant 1). */
    extractTaskId: uuid('extract_task_id'),
    /** Extraction task of the last committed round: the trigger finds a finished extraction by it. */
    lastExtractTaskId: uuid('last_extract_task_id'),
    needsRound: boolean('needs_round').notNull().default(false),
    /** Outcome of the last round; all null until the first one. */
    lastStatus: text('last_status'),
    lastReason: text('last_reason'),
    lastAdded: integer('last_added'),
    lastConfirmed: integer('last_confirmed'),
    lastOutdated: integer('last_outdated'),
    lastModel: text('last_model'),
    lastAt: timestamp('last_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_knowledge_runs_record_idx').on(t.recordId),
    /** The trigger finds the run by the task of an event. */
    index('agent_knowledge_runs_extract_task_idx')
      .on(t.extractTaskId)
      .where(sql`${t.extractTaskId} is not null`),
    index('agent_knowledge_runs_last_extract_task_idx')
      .on(t.lastExtractTaskId)
      .where(sql`${t.lastExtractTaskId} is not null`),
    check(
      'agent_knowledge_runs_last_status_check',
      isOneOf(t.lastStatus, LastExtractionStatusSchema.options),
    ),
    check(
      'agent_knowledge_runs_last_reason_check',
      isOneOf(t.lastReason, LastExtractionReasonSchema.options),
    ),
  ],
);
