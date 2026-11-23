import { EmbeddingFailureReasonSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf } from './helpers';
import { agents } from './agents';

/** The vector row of a deep agent (KD-8): its pass in progress and the last embeddings outcome. */
export const agentKnowledgeEmbedding = app.table(
  'agent_knowledge_embedding',
  {
    recordId: uuid('record_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Pass task in progress (Invariant 13). */
    passTaskId: uuid('pass_task_id'),
    needsPass: boolean('needs_pass').notNull().default(false),
    /** Employee charged for records without a vector; null — the platform. */
    payerId: text('payer_id'),
    /** Reason of the last failed attempt; null — it succeeded. */
    lastReason: text('last_reason'),
    lastModel: text('last_model'),
    lastAt: timestamp('last_at', { withTimezone: true }),
  },
  (t) => [
    /** The trigger finds the row by the task of an event. */
    index('agent_knowledge_embedding_pass_task_idx')
      .on(t.passTaskId)
      .where(sql`${t.passTaskId} is not null`),
    check(
      'agent_knowledge_embedding_last_reason_check',
      isOneOf(t.lastReason, EmbeddingFailureReasonSchema.options),
    ),
  ],
);
