import {
  DecisionStatusSchema,
  DeliveryStatusSchema,
  EVENT_PAYLOAD_MAX_BYTES,
  HistoryEntryKindSchema,
  MessageStatusSchema,
  TaskStatusSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Model of Postgres schema `app` (ADR-0003): every table, constraint and index of `app` is
 * declared here; runtime tables carry the prefix `runtime_`. drizzle-kit generates the
 * migrations in `packages/db/migrations/` from this module.
 *
 * CHECK domains are built from the contract enums in `@agent-os/contracts`, never duplicated here.
 * The cascade starts at the root task: deleting it deletes its tree with its messages, decisions
 * and events. The token ledger has no FK and outlives the tree.
 */
export const app = pgSchema('app');

const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** SQL string literal of a code constant (enum value). */
const literal = (value: string): SQL =>
  sql.raw(`'${value.replaceAll("'", "''")}'`);

/** `column IN (...)` over the values of a contract enum. */
const isOneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.join(values.map(literal), sql`, `)})`;

// ---------------------------------------------------------------------------------------------
// Runtime tables (agent-platform/design-runtime.md, Data Model).
// ---------------------------------------------------------------------------------------------

export const runtimeTasks = app.table(
  'runtime_tasks',
  {
    taskId: uuid('task_id').primaryKey(),
    type: text('type').notNull(),
    ownerId: text('owner_id').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => runtimeTasks.taskId, {
      onDelete: 'cascade',
    }),
    /** The root of the tree; a root task references itself. */
    rootId: uuid('root_id')
      .notNull()
      .references((): AnyPgColumn => runtimeTasks.taskId, {
        onDelete: 'cascade',
      }),
    /** The root has depth 0. */
    depth: integer('depth').notNull(),
    input: jsonb('input').notNull(),
    status: text('status').notNull().default(TaskStatusSchema.enum.queued),
    /** Set exactly while the task is `waiting`. */
    waitReason: text('wait_reason'),
    /** Committed steps of the task. */
    stepNo: integer('step_no').notNull().default(0),
    /** Number of the current claim; fences a step that is no longer current. */
    attempt: integer('attempt').notNull().default(0),
    /** Claims of the current step; 0 after its outcome. */
    stepClaims: integer('step_claims').notNull().default(0),
    /** Losses of the current step found by the sweeper; 0 after its outcome. */
    recoveries: integer('recoveries').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** Next number in the task's inbox. */
    nextMessageSeq: integer('next_message_seq').notNull().default(0),
    result: jsonb('result'),
    /** `{ reason, message }` of a `failed` task. */
    failure: jsonb('failure'),
    createdAt: createdAt(),
    /** Insertion order only: orders tasks created in one transaction, which share `created_at`. */
    createdSeq: bigint('created_seq', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'runtime_tasks_status_check',
      isOneOf(t.status, TaskStatusSchema.options),
    ),
    check(
      'runtime_tasks_wait_reason_check',
      isOneOf(t.waitReason, WaitReasonSchema.options),
    ),
    check(
      'runtime_tasks_waiting_check',
      sql`(${t.status} = ${literal(TaskStatusSchema.enum.waiting)}) = (${t.waitReason} is not null)`,
    ),
    index('runtime_tasks_ready_idx')
      .on(t.status, t.type, t.createdAt)
      .where(sql`${t.status} = ${literal(TaskStatusSchema.enum.queued)}`),
    index('runtime_tasks_root_idx').on(t.rootId),
    index('runtime_tasks_parent_idx').on(t.parentId),
    index('runtime_tasks_owner_idx').on(t.ownerId),
  ],
);

export const runtimeInbox = app.table(
  'runtime_inbox',
  {
    messageId: uuid('message_id').primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    /** Grows within the recipient and orders delivery. */
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    /** Task or employee that sent the message. */
    sender: text('sender').notNull(),
    payload: jsonb('payload').notNull(),
    /** Queue a finished recipient again. */
    revive: boolean('revive').notNull().default(false),
    status: text('status').notNull().default(MessageStatusSchema.enum.pending),
    /** Step that received the message; null while pending. */
    deliveredStep: integer('delivered_step'),
    createdAt: createdAt(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    unique('runtime_inbox_recipient_seq_key').on(t.recipientId, t.seq),
    check(
      'runtime_inbox_status_check',
      isOneOf(t.status, MessageStatusSchema.options),
    ),
    index('runtime_inbox_pending_idx')
      .on(t.recipientId, t.seq)
      .where(sql`${t.status} = ${literal(MessageStatusSchema.enum.pending)}`),
  ],
);

export const runtimeDecisions = app.table(
  'runtime_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    rootId: uuid('root_id').notNull(),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default(DecisionStatusSchema.enum.open),
    resolution: jsonb('resolution'),
    /** Step the decision was handed to; null until then. */
    deliveredStep: integer('delivered_step'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'runtime_decisions_status_check',
      isOneOf(t.status, DecisionStatusSchema.options),
    ),
    /** Invariant 3: a task has at most one open request. */
    uniqueIndex('runtime_decisions_open_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} = ${literal(DecisionStatusSchema.enum.open)}`),
    index('runtime_decisions_root_idx').on(t.rootId),
  ],
);

export const runtimeEvents = app.table(
  'runtime_events',
  {
    eventId: uuid('event_id').primaryKey(),
    /** Insertion order only; carries no meaning across trees. */
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** Root of the tree: the correlation of every event of the tree. */
    rootId: uuid('root_id')
      .notNull()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    taskId: uuid('task_id'),
    causationId: uuid('causation_id'),
    stateRevision: integer('state_revision').notNull(),
    payloadRef: text('payload_ref'),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'runtime_events_payload_size_check',
      sql`octet_length(${t.payload}::text) <= ${sql.raw(String(EVENT_PAYLOAD_MAX_BYTES))}`,
    ),
    index('runtime_events_root_seq_idx').on(t.rootId, t.seq),
    index('runtime_events_causation_idx').on(t.causationId),
    index('runtime_events_task_seq_idx').on(t.taskId, t.seq),
  ],
);

export const runtimeEventDeliveries = app.table(
  'runtime_event_deliveries',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => runtimeEvents.eventId, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    status: text('status').notNull().default(DeliveryStatusSchema.enum.pending),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.consumer] }),
    check(
      'runtime_event_deliveries_status_check',
      isOneOf(t.status, DeliveryStatusSchema.options),
    ),
    index('runtime_event_deliveries_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = ${literal(DeliveryStatusSchema.enum.pending)}`),
  ],
);

/** Token ledger (KD-5): one row per model call; no FK to the task, so rows outlive the tree. */
export const runtimeModelCalls = app.table(
  'runtime_model_calls',
  {
    callId: uuid('call_id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    /** Task that made the call; null for a call outside a task. */
    taskId: uuid('task_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    costUsd: numeric('cost_usd', {
      precision: 18,
      scale: 9,
      mode: 'number',
    }).notNull(),
    /** Time of the record; the month of a call is counted by UTC. */
    calledAt: timestamp('called_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('runtime_model_calls_owner_called_idx').on(t.ownerId, t.calledAt)],
);

// ---------------------------------------------------------------------------------------------
// Agent tables (agent-platform/design-agents.md, Data Model). The session key is the runtime task
// id, so deleting a task tree deletes its sessions, histories and tool calls.
// ---------------------------------------------------------------------------------------------

export const agentSessions = app.table('agent_sessions', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
  /** Owner of the task; read only by the `task.failed` consumer. */
  ownerId: text('owner_id').notNull(),
  definition: text('definition').notNull(),
  description: text('description').notNull(),
  /** Model chosen at start; every call of the session uses it. */
  model: text('model').notNull(),
  /** Task text; `restart` starts a new agent with it. */
  prompt: text('prompt').notNull(),
  /** Session limits set by the caller at start. */
  limits: jsonb('limits'),
  /** Fork source: the parent's history up to `forked_through_seq` precedes this one. No FK. */
  forkedFromTaskId: uuid('forked_from_task_id'),
  forkedThroughSeq: integer('forked_through_seq'),
  turns: integer('turns').notNull().default(0),
  interrupted: boolean('interrupted').notNull().default(false),
  /** Set when the agent itself finished (`complete` or `fail`). */
  closed: boolean('closed').notNull().default(false),
  /** Input tokens of the last model call; drives compaction. */
  lastInputTokens: integer('last_input_tokens'),
  createdAt: createdAt(),
});

/** History of an agent: append-only, `seq` grows within the session. */
export const agentMessages = app.table(
  'agent_messages',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    content: jsonb('content').notNull(),
    /** Token ledger row of a `model_answer`; no FK, the ledger outlives the tree. */
    modelCallId: uuid('model_call_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.seq] }),
    check(
      'agent_messages_kind_check',
      isOneOf(t.kind, HistoryEntryKindSchema.options),
    ),
  ],
);

/** One row per tool call of a model answer: the audit record of the call. */
export const agentToolCalls = app.table(
  'agent_tool_calls',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    /** Call id given by the provider. */
    callId: text('call_id').notNull(),
    /** `seq` of the `model_answer` that requested the call. */
    answerSeq: integer('answer_seq').notNull(),
    /** Position of the call within its answer. */
    position: integer('position').notNull(),
    tool: text('tool').notNull(),
    /** MCP server id; null for built-in and registered tools. */
    server: text('server'),
    args: jsonb('args').notNull(),
    state: text('state')
      .notNull()
      .default(ToolCallStateSchema.enum.requested),
    /** Set exactly while the state is `done`. */
    outcome: text('outcome'),
    refusalReason: text('refusal_reason'),
    resultText: text('result_text'),
    /** Agent started by `start_agent`. */
    childTaskId: uuid('child_task_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.callId] }),
    check(
      'agent_tool_calls_state_check',
      isOneOf(t.state, ToolCallStateSchema.options),
    ),
    check(
      'agent_tool_calls_outcome_check',
      isOneOf(t.outcome, ToolOutcomeSchema.options),
    ),
    check(
      'agent_tool_calls_refusal_reason_check',
      isOneOf(t.refusalReason, ToolRefusalReasonSchema.options),
    ),
    check(
      'agent_tool_calls_done_check',
      sql`(${t.state} = ${literal(ToolCallStateSchema.enum.done)}) = (${t.outcome} is not null)`,
    ),
    index('agent_tool_calls_awaiting_idx')
      .on(t.state)
      .where(
        sql`${t.state} = ${literal(ToolCallStateSchema.enum.awaiting_confirmation)}`,
      ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Chat conversations (agent-platform/design-chat.md, Data Model, KD-1). No FK to the root task:
// the row is locked during the tree's deletion and removed after the tree.
// ---------------------------------------------------------------------------------------------

export const chatConversations = app.table(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    /** Empty string until the title is written; the API returns `null` for it. */
    title: text('title').notNull().default(''),
    /** The root session of agent `chat`; null until the first message. One root, one conversation. */
    rootId: uuid('root_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_conversations_root_idx').on(t.rootId),
    index('chat_conversations_owner_page_idx').on(
      t.ownerId,
      t.updatedAt.desc(),
      t.id.desc(),
    ),
  ],
);
