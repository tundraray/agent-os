import {
  ABSOLUTE_MINUTES_DEFAULT,
  ABSOLUTE_MINUTES_MAX,
  ABSOLUTE_MINUTES_MIN,
  CALL_RECORD_KINDS,
  DecisionStatusSchema,
  DeliveryStatusSchema,
  EmbeddingFailureReasonSchema,
  EMBEDDING_DIMENSIONS_MAX,
  EMBEDDING_DIMENSIONS_MIN,
  EVENT_PAYLOAD_MAX_BYTES,
  GrantEffectSchema,
  GrantTargetKindSchema,
  HistoryEntryKindSchema,
  IDLE_MINUTES_DEFAULT,
  IDLE_MINUTES_MAX,
  IDLE_MINUTES_MIN,
  KNOWLEDGE_LIMIT_TOKENS_DEFAULT,
  KNOWLEDGE_LIMIT_TOKENS_MAX,
  KNOWLEDGE_LIMIT_TOKENS_MIN,
  KnowledgeItemKindSchema,
  KnowledgeItemTypeSchema,
  LastExtractionReasonSchema,
  LanguageSchema,
  LastExtractionStatusSchema,
  McpServerModeSchema,
  MessageStatusSchema,
  ModelProviderKindSchema,
  ModelPurposeSchema,
  ProviderTypeSchema,
  RECORD_MAX_TURNS_DEFAULT,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  RecordKindSchema,
  SessionTaskStatusSchema,
  SINGLE_CALL_RECORD_KINDS,
  TaskStatusSchema,
  TOOL_RESULT_PREVIEW_CHARS_DEFAULT,
  TOOL_RESULT_PREVIEW_CHARS_MAX,
  TOOL_RESULT_PREVIEW_CHARS_MIN,
  TOOL_RESULT_READ_MAX_TOKENS_DEFAULT,
  TOOL_RESULT_READ_MAX_TOKENS_MAX,
  TOOL_RESULT_READ_MAX_TOKENS_MIN,
  TOOL_RESULT_STORE_FROM_CHARS_DEFAULT,
  TOOL_RESULT_STORE_FROM_CHARS_MAX,
  TOOL_RESULT_STORE_FROM_CHARS_MIN,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  TrackerStatusSchema,
  UserStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Model of Postgres schema `app` (ADR-0003): every table, constraint and index of `app` is
 * declared here; runtime tables carry the prefix `runtime_`. drizzle-kit generates the
 * migrations in `packages/db/src/migrations/` from this module.
 *
 * CHECK domains are built from the contract enums in `@agent-os/contracts`, never duplicated here.
 * The cascade starts at the root task: deleting it deletes its tree with its messages, decisions
 * and events. The application marks a tree deleted (`deleted_at`) rather than deleting it; the
 * cascades stay for a future retention purge. The token ledger has no FK and outlives the tree.
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

/** `column BETWEEN min AND max` over code constants. */
const isWithin = (column: AnyPgColumn, min: number, max: number): SQL =>
  sql`${column} between ${sql.raw(String(min))} and ${sql.raw(String(max))}`;

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
    /** Set on every task of a deleted tree, which answers as a missing one; null otherwise. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The tracker the task belongs to, set when a step's commit opened it; null otherwise. */
    trackerId: uuid('tracker_id').references((): AnyPgColumn => runtimeTrackers.trackerId, {
      onDelete: 'cascade',
    }),
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
    /** The claim: the oldest `queued` task of the registered types, in this order. */
    index('runtime_tasks_ready_idx')
      .on(t.createdAt, t.taskId)
      .where(sql`${t.status} = ${literal(TaskStatusSchema.enum.queued)}`),
    /** The recovery sweeper: `running` tasks whose lease has expired, oldest first. */
    index('runtime_tasks_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = ${literal(TaskStatusSchema.enum.running)}`),
    index('runtime_tasks_root_idx').on(t.rootId),
    index('runtime_tasks_parent_idx').on(t.parentId),
    /** The end of a tracker's task counts the tracker's unfinished tasks. */
    index('runtime_tasks_tracker_idx').on(t.trackerId),
  ],
);

/**
 * Task trackers (deep-agents/design-task.md, Data Model): a step's commit opens one with its child
 * tasks, and the end of the last of them finishes it with one `tasks_finished` to the owner task.
 * Written only by the runtime, under the lock of the owner task's row.
 */
export const runtimeTrackers = app.table(
  'runtime_trackers',
  {
    trackerId: uuid('tracker_id').primaryKey(),
    /** The task whose step opened the tracker: the parent of its tasks. */
    taskId: uuid('task_id')
      .notNull()
      .references((): AnyPgColumn => runtimeTasks.taskId, { onDelete: 'cascade' }),
    /** The employee who owns the task. */
    ownerId: text('owner_id').notNull(),
    status: text('status').notNull().default(TrackerStatusSchema.enum.open),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('runtime_trackers_status_check', isOneOf(t.status, TrackerStatusSchema.options)),
    /** A task has at most one open tracker. */
    uniqueIndex('runtime_trackers_open_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} = ${literal(TrackerStatusSchema.enum.open)}`),
    /** `trackers.list` and the cascade from the task; the partial index covers only open ones. */
    index('runtime_trackers_task_idx').on(t.taskId),
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
    /** Serves the cascade from the task; the partial index above covers only open requests. */
    index('runtime_decisions_task_idx').on(t.taskId),
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
    /** Kept for incident analysis; no code reads it. */
    causationId: uuid('causation_id'),
    /** Kept for incident analysis; no code reads it. */
    stateRevision: integer('state_revision').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'runtime_events_payload_size_check',
      sql`octet_length(${t.payload}::text) <= ${sql.raw(String(EVENT_PAYLOAD_MAX_BYTES))}`,
    ),
    index('runtime_events_root_seq_idx').on(t.rootId, t.seq),
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
// id; the cascade from it stays for a future retention purge, the application marks a conversation
// deleted (`deleted_at`) rather than deleting it.
// ---------------------------------------------------------------------------------------------

export const agentSessions = app.table(
  'agent_sessions',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    /**
     * The task's parent and root, copied from `runtime_tasks` when the row is written (a root names
     * itself as its root), so the chain reads from this table. No FK: the row is deleted by the cascade
     * of `task_id` alone.
     */
    parentId: uuid('parent_id'),
    rootId: uuid('root_id').notNull(),
    /** Owner of the task. */
    ownerId: text('owner_id').notNull(),
    /**
     * Set only on a root session, which the owner sees as a conversation: its title (empty until one
     * is written) and its last change, the key of the owner's list. Null on every other session.
     */
    title: text('title'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Name of the run from its snapshot (custom-agents/design-runtime.md, KD-3). */
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Model of the snapshot; every call of the session uses it. */
    model: text('model').notNull(),
    /** Task text; `restart` starts a new agent with it. */
    prompt: text('prompt').notNull(),
    /**
     * Origin of the run: the library record it started from, as it was at the start; a root session
     * carries the builtin record `chat`. No FK: the record may be deleted. The snapshot itself lives
     * only in the task input (ADR-0017).
     */
    recordId: uuid('record_id').notNull(),
    recordKind: text('record_kind').notNull(),
    recordVersion: integer('record_version').notNull(),
    recordName: text('record_name').notNull(),
    authorId: uuid('author_id'),
    authorName: text('author_name'),
    builtinKey: text('builtin_key'),
    /** Subagent name of a run of a subagent; null otherwise. */
    subagent: text('subagent'),
    /** The owner had no earlier session with this record. */
    firstRun: boolean('first_run').notNull().default(false),
    /** Fork source: the parent's history up to `forked_through_seq` precedes this one. No FK. */
    forkedFromTaskId: uuid('forked_from_task_id'),
    forkedThroughSeq: integer('forked_through_seq'),
    turns: integer('turns').notNull().default(0),
    interrupted: boolean('interrupted').notNull().default(false),
    /** Set when the agent itself finished (`complete` or `fail`). */
    closed: boolean('closed').notNull().default(false),
    /** Input tokens of the last model call; drives compaction. */
    lastInputTokens: integer('last_input_tokens'),
    /**
     * The last number given to a task of the session's list (deep-agents design-task-list.md, KD-1); never
     * goes back, so a deleted task's number is not given again.
     */
    lastTaskNumber: integer('last_task_number').notNull().default(0),
    createdAt: createdAt(),
    /** Set only on the root session of a deleted conversation, which answers as a missing one. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /** Counts the owner's runs of a record for the chat listing. */
    index('agent_sessions_owner_record_idx').on(t.ownerId, t.recordId),
    index('agent_sessions_root_idx').on(t.rootId),
    /** The owner's conversations, last changed first; the condition is the agents' `isRoot`. */
    index('agent_sessions_owner_page_idx')
      .on(t.ownerId, t.updatedAt.desc(), t.taskId.desc())
      .where(sql`${t.updatedAt} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * History of an agent: append-only, `seq` grows within the session. A tool call is an item of its
 * `model_answer`; what happened to it are later rows keyed by `call_id` — nothing is updated in place.
 */
export const agentMessages = app.table(
  'agent_messages',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    content: jsonb('content').notNull(),
    /**
     * Token ledger row of a `model_answer`; no FK, the ledger outlives the tree. Kept for incident
     * analysis; no code reads it.
     */
    modelCallId: uuid('model_call_id'),
    /** The call a call record is about (`CALL_RECORD_KINDS`); null for every other kind. */
    callId: text('call_id'),
    /** When the call of a `tool_result` ended: the window and the order of the extraction input. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.seq] }),
    index('agent_messages_call_idx').on(t.taskId, t.callId),
    /** A call has at most one result, one confirmation request, one decision and one intent. */
    uniqueIndex('agent_messages_call_once_idx')
      .on(t.taskId, t.callId, t.kind)
      .where(isOneOf(t.kind, SINGLE_CALL_RECORD_KINDS)),
    /** The results of a task by end time: the extraction window and the count of started runs. */
    index('agent_messages_result_idx')
      .on(t.taskId, t.finishedAt)
      .where(sql`${t.kind} = ${literal(HistoryEntryKindSchema.enum.tool_result)}`),
    check(
      'agent_messages_kind_check',
      isOneOf(t.kind, HistoryEntryKindSchema.options),
    ),
    check(
      'agent_messages_call_id_check',
      sql`(${t.callId} is not null) = (${isOneOf(t.kind, CALL_RECORD_KINDS)})`,
    ),
    check(
      'agent_messages_finished_at_check',
      sql`(${t.finishedAt} is not null) = (${t.kind} = ${literal(HistoryEntryKindSchema.enum.tool_result)})`,
    ),
  ],
);

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

/** The single row of the large tool result settings (tool-result-reading R-5); the migration creates it. */
export const agentToolResultSettings = app.table(
  'agent_tool_result_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    storeFromChars: integer('store_from_chars')
      .notNull()
      .default(TOOL_RESULT_STORE_FROM_CHARS_DEFAULT),
    previewChars: integer('preview_chars').notNull().default(TOOL_RESULT_PREVIEW_CHARS_DEFAULT),
    readMaxTokens: integer('read_max_tokens').notNull().default(TOOL_RESULT_READ_MAX_TOKENS_DEFAULT),
    /** Null while the defaults stand. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('agent_tool_result_settings_single_row_check', sql`${t.id}`),
    check(
      'agent_tool_result_settings_store_from_chars_check',
      isWithin(t.storeFromChars, TOOL_RESULT_STORE_FROM_CHARS_MIN, TOOL_RESULT_STORE_FROM_CHARS_MAX),
    ),
    check(
      'agent_tool_result_settings_preview_chars_check',
      isWithin(t.previewChars, TOOL_RESULT_PREVIEW_CHARS_MIN, TOOL_RESULT_PREVIEW_CHARS_MAX),
    ),
    check(
      'agent_tool_result_settings_read_max_tokens_check',
      isWithin(t.readMaxTokens, TOOL_RESULT_READ_MAX_TOKENS_MIN, TOOL_RESULT_READ_MAX_TOKENS_MAX),
    ),
  ],
);

/** Audit of the tool calls a `run_code` script made; the result is seen only by the script (code-execution KD-6). */
export const agentCodeCalls = app.table(
  'agent_code_calls',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
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
    primaryKey({ columns: [t.taskId, t.runCallId, t.attempt, t.seq] }),
    check(
      'agent_code_calls_outcome_check',
      isOneOf(t.outcome, ToolOutcomeSchema.options),
    ),
    check(
      'agent_code_calls_refusal_reason_check',
      isOneOf(t.refusalReason, ToolRefusalReasonSchema.options),
    ),
  ],
);

/**
 * The task list of a session (deep-agents/design-task-list.md, KD-1, Data Model): one row per task, keyed by
 * the session and the task's number, which `agent_sessions.last_task_number` gives and never gives again.
 * `blocked_by` holds numbers of the same list. Written in the step transaction with the `tool_result` that
 * changed it; deleting the session deletes its tasks.
 */
export const agentSessionTasks = app.table(
  'agent_session_tasks',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    activeForm: text('active_form'),
    status: text('status').notNull().default(SessionTaskStatusSchema.enum.pending),
    owner: text('owner'),
    blockedBy: integer('blocked_by').array().notNull().default(sql`'{}'::integer[]`),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.number] }),
    check('agent_session_tasks_status_check', isOneOf(t.status, SessionTaskStatusSchema.options)),
  ],
);

// ---------------------------------------------------------------------------------------------
// MCP registry and employee accounts (enterprise-access/design-mcp-connect.md, Data Model, KD-1).
// Owned by the `agents` package (ADR-0014). Tokens and the client secret are stored as is.
// ---------------------------------------------------------------------------------------------

export const agentMcpServers = app.table(
  'agent_mcp_servers',
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
    check('agent_mcp_servers_mode_check', isOneOf(t.mode, McpServerModeSchema.options)),
    check(
      'agent_mcp_servers_shared_token_check',
      sql`(${t.mode} = ${literal(McpServerModeSchema.enum.shared)}) = (${t.sharedToken} is not null)`,
    ),
    /** Invariant 2: an enabled server always has its tool list. */
    check('agent_mcp_servers_enabled_tools_check', sql`not ${t.enabled} or ${t.tools} is not null`),
    check(
      'agent_mcp_servers_oauth_client_check',
      sql`${t.mode} <> ${literal(McpServerModeSchema.enum.oauth)} or ${t.oauthClientId} is not null`,
    ),
  ],
);

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

// ---------------------------------------------------------------------------------------------
// Model providers (model-providers/design-core.md, Data Model, KD-1). Owned by the `agents` package.
// A catalogue model names its provider by the first part of its id, as text without FK (ADR-0018).
// The key is stored as is.
// ---------------------------------------------------------------------------------------------

export const agentModelProviders = app.table(
  'agent_model_providers',
  {
    /** Never changes: model ids carry it as their first part. */
    name: text('name').primaryKey(),
    /** Never changes after registration. */
    kind: text('kind').notNull(),
    /** Null — the kind's default address. */
    baseUrl: text('base_url'),
    /** Null — no key set. */
    apiKey: text('api_key'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('agent_model_providers_kind_check', isOneOf(t.kind, ModelProviderKindSchema.options)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Identity (enterprise-access/design-identity.md, Data Model). Read only by the `identity` module
// of `apps/api`. Email and login are stored normalized (trimmed, lower case), so a plain unique
// index makes them unique regardless of case. Owner columns of `runtime` and `agents` stay text
// without FK (ADR-0012).
// ---------------------------------------------------------------------------------------------

export const identityUsers = app.table(
  'identity_users',
  {
    /** Issued by the server, never taken from a provider (Invariant 3). */
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** Empty string when there is no name. */
    name: text('name').notNull().default(''),
    /** Login of a local account; null for provider-only accounts. */
    login: text('login'),
    /** argon2id hash with its parameters; null for provider-only accounts. */
    passwordHash: text('password_hash'),
    status: text('status').notNull().default(UserStatusSchema.enum.active),
    /** Personal admin right, besides admin roles. */
    isAdmin: boolean('is_admin').notNull().default(false),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    /** The chosen interface language; null while the employee has not chosen one (i18n KD-4). */
    language: text('language'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('identity_users_email_idx').on(t.email),
    uniqueIndex('identity_users_login_idx').on(t.login),
    check('identity_users_status_check', isOneOf(t.status, UserStatusSchema.options)),
    check('identity_users_language_check', isOneOf(t.language, LanguageSchema.options)),
  ],
);

export const identityRoles = app.table(
  'identity_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    /** The built-in «Супер-администратор»: created by the migration, never changed (KD-6). */
    builtin: boolean('builtin').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('identity_roles_name_idx').on(sql`lower(${t.name})`)],
);

export const identityRoleMembers = app.table(
  'identity_role_members',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => identityRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.userId] }),
    index('identity_role_members_user_idx').on(t.userId),
  ],
);

export const identityProviders = app.table(
  'identity_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Never changes after creation. */
    type: text('type').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** Grows with every change of the provider. */
    version: integer('version').notNull().default(1),
    /** Settings of the type, the client secret included as is (KD-7). */
    options: jsonb('options').notNull().default({}),
    /** Orders the providers. */
    createdAt: createdAt(),
  },
  (t) => [check('identity_providers_type_check', isOneOf(t.type, ProviderTypeSchema.options))],
);

/** One-time sign-in request; the row is deleted at the first return from the provider. */
export const identityLoginRequests = app.table('identity_login_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: text('state').notNull().unique('identity_login_requests_state_key'),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => identityProviders.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  /** PKCE verifier. */
  codeVerifier: text('code_verifier').notNull(),
  /** Web path to return to after sign-in. */
  next: text('next').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/** Session of an employee; its limits are computed from the settings, not stored (KD-2). */
export const identitySessions = app.table(
  'identity_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the session token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique('identity_sessions_token_hash_key'),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Why the session was ended (`account_disabled`, DC-9); null while it is live. */
    endedReason: text('ended_reason'),
  },
  (t) => [index('identity_sessions_user_idx').on(t.userId)],
);

/** The single row of the part's settings (SignInSettings); the migration creates it. */
export const identitySettings = app.table(
  'identity_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    /** Public address without `/api`; null until saved. */
    publicUrl: text('public_url'),
    idleMinutes: integer('idle_minutes').notNull().default(IDLE_MINUTES_DEFAULT),
    absoluteMinutes: integer('absolute_minutes').notNull().default(ABSOLUTE_MINUTES_DEFAULT),
    /** Null while the defaults stand. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('identity_settings_single_row_check', sql`${t.id}`),
    check(
      'identity_settings_idle_minutes_check',
      isWithin(t.idleMinutes, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX),
    ),
    check(
      'identity_settings_absolute_minutes_check',
      isWithin(t.absoluteMinutes, ABSOLUTE_MINUTES_MIN, ABSOLUTE_MINUTES_MAX),
    ),
    check(
      'identity_settings_idle_not_above_absolute_check',
      sql`${t.idleMinutes} <= ${t.absoluteMinutes}`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Access (enterprise-access/design-access.md, Data Model, KD-1, KD-3). Read and written only by the
// `access` module of `apps/api` (ADR-0015). A grant names its MCP server and tool as text without
// FK: the registry belongs to the `agents` package (ADR-0014).
// ---------------------------------------------------------------------------------------------

/** Price in USD per million tokens. */
const usdPerMTok = (name: string) => numeric(name, { precision: 18, scale: 9, mode: 'number' });


/** Model catalogue: a model is callable only when it is here. */
export const accessModels = app.table(
  'access_models',
  {
    /** Model ID as the provider knows it. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    inputUsdPerMTok: usdPerMTok('input_usd_per_mtok').notNull(),
    outputUsdPerMTok: usdPerMTok('output_usd_per_mtok').notNull(),
    cacheWriteUsdPerMTok: usdPerMTok('cache_write_usd_per_mtok').notNull(),
    cacheReadUsdPerMTok: usdPerMTok('cache_read_usd_per_mtok').notNull(),
    /** Long-context prices apply when the whole input of a call is above this; null — one price. */
    longContextAboveInputTokens: integer('long_context_above_input_tokens'),
    longContextInputUsdPerMTok: usdPerMTok('long_context_input_usd_per_mtok'),
    longContextOutputUsdPerMTok: usdPerMTok('long_context_output_usd_per_mtok'),
    longContextCacheWriteUsdPerMTok: usdPerMTok('long_context_cache_write_usd_per_mtok'),
    longContextCacheReadUsdPerMTok: usdPerMTok('long_context_cache_read_usd_per_mtok'),
    /** Never changes after the model is added. */
    purpose: text('purpose').notNull().default(ModelPurposeSchema.enum.chat),
    /** Vector length of an embedding model; null for a chat model. */
    dimensions: integer('dimensions'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** Null long-context prices pass: `null >= 0` is not false. */
    check(
      'access_models_prices_check',
      sql`${t.inputUsdPerMTok} >= 0 and ${t.outputUsdPerMTok} >= 0
        and ${t.cacheWriteUsdPerMTok} >= 0 and ${t.cacheReadUsdPerMTok} >= 0
        and ${t.longContextInputUsdPerMTok} >= 0 and ${t.longContextOutputUsdPerMTok} >= 0
        and ${t.longContextCacheWriteUsdPerMTok} >= 0 and ${t.longContextCacheReadUsdPerMTok} >= 0`,
    ),
    check(
      'access_models_long_context_threshold_check',
      sql`${t.longContextAboveInputTokens} > 0`,
    ),
    /** All five long-context columns are set or none; `or` keeps the CHECK out of `= ANY`. */
    check(
      'access_models_long_context_check',
      sql`num_nulls(${t.longContextAboveInputTokens}, ${t.longContextInputUsdPerMTok},
          ${t.longContextOutputUsdPerMTok}, ${t.longContextCacheWriteUsdPerMTok},
          ${t.longContextCacheReadUsdPerMTok}) = 0
        or num_nulls(${t.longContextAboveInputTokens}, ${t.longContextInputUsdPerMTok},
          ${t.longContextOutputUsdPerMTok}, ${t.longContextCacheWriteUsdPerMTok},
          ${t.longContextCacheReadUsdPerMTok}) = 5`,
    ),
    check('access_models_purpose_check', isOneOf(t.purpose, ModelPurposeSchema.options)),
    /**
     * An embedding model has dimensions and no long-context prices; a chat model has no dimensions.
     * `is not null` keeps a null from passing: `null between …` is not false.
     */
    check(
      'access_models_dimensions_check',
      sql`(${t.purpose} = ${literal(ModelPurposeSchema.enum.embedding)}
          and ${t.dimensions} is not null
          and ${isWithin(t.dimensions, EMBEDDING_DIMENSIONS_MIN, EMBEDDING_DIMENSIONS_MAX)}
          and ${t.longContextAboveInputTokens} is null)
        or (${t.purpose} = ${literal(ModelPurposeSchema.enum.chat)} and ${t.dimensions} is null)`,
    ),
  ],
);

/** The single row of the default models (ModelDefaults); the migration creates it. */
export const accessModelDefaults = app.table(
  'access_model_defaults',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    /** Null — not chosen; deleting the model clears the choice (DC-6). */
    chatModel: text('chat_model').references(() => accessModels.id, { onDelete: 'set null' }),
    embeddingModel: text('embedding_model').references(() => accessModels.id, {
      onDelete: 'set null',
    }),
    /** Null while nothing was changed. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Employee id; null while nothing was changed. */
    updatedBy: text('updated_by'),
  },
  (t) => [check('access_model_defaults_single_row_check', sql`${t.id}`)],
);

/** A grant of a role or an employee on a server, a tool or a model; one per holder, effect, target. */
export const accessGrants = app.table(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('role_id').references(() => identityRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => identityUsers.id, { onDelete: 'cascade' }),
    effect: text('effect').notNull(),
    targetKind: text('target_kind').notNull(),
    server: text('server'),
    tool: text('tool'),
    model: text('model').references(() => accessModels.id, { onDelete: 'cascade' }),
    /** Monthly quota of a model allow; null — no quota. */
    quotaUsd: numeric('quota_usd', { precision: 12, scale: 2, mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('access_grants_holder_target_key')
      .on(t.roleId, t.userId, t.effect, t.targetKind, t.server, t.tool, t.model)
      .nullsNotDistinct(),
    /** The cascade from a role is served by the unique key above: `role_id` is its first column. */
    index('access_grants_user_idx').on(t.userId),
    check('access_grants_effect_check', isOneOf(t.effect, GrantEffectSchema.options)),
    check('access_grants_target_kind_check', isOneOf(t.targetKind, GrantTargetKindSchema.options)),
    check('access_grants_holder_check', sql`num_nonnulls(${t.roleId}, ${t.userId}) = 1`),
    check(
      'access_grants_target_check',
      sql`(${t.targetKind} = ${literal(GrantTargetKindSchema.enum.server)}
          and ${t.server} is not null and ${t.tool} is null and ${t.model} is null)
        or (${t.targetKind} = ${literal(GrantTargetKindSchema.enum.tool)}
          and ${t.server} is not null and ${t.tool} is not null and ${t.model} is null)
        or (${t.targetKind} = ${literal(GrantTargetKindSchema.enum.model)}
          and ${t.server} is null and ${t.tool} is null and ${t.model} is not null)`,
    ),
    /** Invariant 2: a deny belongs only to an employee. */
    check(
      'access_grants_deny_holder_check',
      sql`${t.effect} = ${literal(GrantEffectSchema.enum.allow)} or ${t.userId} is not null`,
    ),
    check(
      'access_grants_quota_check',
      sql`${t.quotaUsd} is null or (${t.effect} = ${literal(GrantEffectSchema.enum.allow)}
        and ${t.targetKind} = ${literal(GrantTargetKindSchema.enum.model)})`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Library (custom-agents/design-library.md, Data Model, KD-1). Read and written only by the
// `library` module of `apps/api` (ADR-0016). The content of a record is one jsonb in the form of its
// kind, checked by the kind's schema in `@agent-os/contracts`. A holder is a role or an employee
// with FK and cascade, as in `access_grants`, or "everyone".
// ---------------------------------------------------------------------------------------------

/** A record of any kind: an employee's (with an owner) or a system one (no owner). */
export const libraryRecords = app.table(
  'library_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** Null — a system record. */
    ownerId: uuid('owner_id').references(() => identityUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    offerInChat: boolean('offer_in_chat').notNull().default(false),
    /** Key of a built-in system record (`chat`); null for every other record. */
    builtinKey: text('builtin_key'),
    content: jsonb('content').notNull(),
    /** Grows with every edit of the record. */
    version: integer('version').notNull().default(1),
    /** When an admin closed sharing of an employee record; null — not closed. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** A name is unique per owner regardless of case and kind; system records are one group. */
    uniqueIndex('library_records_owner_name_idx')
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.ownerId} is not null`),
    uniqueIndex('library_records_system_name_idx')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.ownerId} is null`),
    uniqueIndex('library_records_builtin_key_idx').on(t.builtinKey),
    check('library_records_kind_check', isOneOf(t.kind, RecordKindSchema.options)),
    check(
      'library_records_builtin_key_check',
      sql`${t.builtinKey} is null or ${t.ownerId} is null`,
    ),
    check(
      'library_records_closed_at_check',
      sql`${t.closedAt} is null or ${t.ownerId} is not null`,
    ),
  ],
);

/** A holder of a record's audience: exactly one of a role, an employee or everyone. */
export const libraryShares = app.table(
  'library_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => libraryRecords.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').references(() => identityRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => identityUsers.id, { onDelete: 'cascade' }),
    everyone: boolean('everyone').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('library_shares_record_holder_key')
      .on(t.recordId, t.roleId, t.userId, t.everyone)
      .nullsNotDistinct(),
    index('library_shares_role_idx').on(t.roleId),
    index('library_shares_user_idx').on(t.userId),
    check(
      'library_shares_holder_check',
      sql`num_nonnulls(${t.roleId}, ${t.userId}, nullif(${t.everyone}, false)) = 1`,
    ),
  ],
);

/** The single row of the library's settings (LibrarySettings); the migration creates it. */
export const librarySettings = app.table(
  'library_settings',
  {
    /** Always `true`: keeps the table at one row. */
    id: boolean('id').primaryKey().default(true),
    /** «Максимум шагов» a new agent or deep agent starts with; each record may change its own. */
    defaultMaxTurns: integer('default_max_turns').notNull().default(RECORD_MAX_TURNS_DEFAULT),
    /** Null while the default stands. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('library_settings_single_row_check', sql`${t.id}`),
    check(
      'library_settings_default_max_turns_check',
      isWithin(t.defaultMaxTurns, RECORD_MAX_TURNS_MIN, RECORD_MAX_TURNS_MAX),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Knowledge of self-learning deep agents (self-learning/design-core.md, Data Model). Owned by the
// `agents` package (KD-1). The graph, its vectors and the deep agent's vector row reference
// `library_records` with cascade — the one exception to package tables not referencing app tables:
// deleting a deep agent by any path takes its knowledge with it, while `agents` never reads `library_*`.
// ---------------------------------------------------------------------------------------------

/** pgvector column without a fixed length (KD-8); the type lives where the extension is installed. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value): number[] => JSON.parse(value) as number[],
});

/** Fields of every graph record (KD-5); the runs are kept for review and confirmations, no FK. */
const knowledgeItemFields = () => ({
  recordId: uuid('record_id')
    .notNull()
    .references(() => libraryRecords.id, { onDelete: 'cascade' }),
  confirmations: integer('confirmations').notNull().default(1),
  createdAt: createdAt(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  /** Coordinator task of the run that added the record. Kept for incident analysis; no code reads it. */
  sourceRunId: uuid('source_run_id').notNull(),
  /** Coordinator task of the run that confirmed it last. */
  confirmedByRunId: uuid('confirmed_by_run_id').notNull(),
  outdated: boolean('outdated').notNull().default(false),
});

/** An entity of a deep agent's graph: always a fact. */
export const agentKnowledgeEntities = app.table(
  'agent_knowledge_entities',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    ...knowledgeItemFields(),
    name: text('name').notNull(),
    description: text('description').notNull(),
  },
  (t) => [
    index('agent_knowledge_entities_record_idx').on(t.recordId),
    /** Invariant 4. */
    check('agent_knowledge_entities_confirmations_check', sql`${t.confirmations} >= 1`),
  ],
);

/**
 * A relation: a fact joins two entities of the same graph and goes with either of them
 * (Invariant 6); a lesson and «searched — found nothing» name a tool and a kind of question instead.
 */
export const agentKnowledgeRelations = app.table(
  'agent_knowledge_relations',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    ...knowledgeItemFields(),
    kind: text('kind').notNull(),
    fromEntityId: integer('from_entity_id'),
    toEntityId: integer('to_entity_id'),
    label: text('label'),
    server: text('server'),
    tool: text('tool'),
    question: text('question'),
    hint: text('hint'),
    outcome: text('outcome'),
  },
  (t) => [
    index('agent_knowledge_relations_record_idx').on(t.recordId),
    /** Serve the cascade from an entity. */
    index('agent_knowledge_relations_from_entity_idx').on(t.fromEntityId),
    index('agent_knowledge_relations_to_entity_idx').on(t.toEntityId),
    /** Named: the generated names pass the 63-character limit of Postgres. */
    foreignKey({
      name: 'agent_knowledge_relations_from_entity_fk',
      columns: [t.fromEntityId],
      foreignColumns: [agentKnowledgeEntities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_knowledge_relations_to_entity_fk',
      columns: [t.toEntityId],
      foreignColumns: [agentKnowledgeEntities.id],
    }).onDelete('cascade'),
    /** Invariant 4. */
    check('agent_knowledge_relations_confirmations_check', sql`${t.confirmations} >= 1`),
    check('agent_knowledge_relations_kind_check', isOneOf(t.kind, KnowledgeItemKindSchema.options)),
    check(
      'agent_knowledge_relations_shape_check',
      sql`(${t.kind} = ${literal(KnowledgeItemKindSchema.enum.fact)}
          and ${t.fromEntityId} is not null and ${t.toEntityId} is not null
          and ${t.label} is not null and ${t.server} is null and ${t.tool} is null
          and ${t.question} is null and ${t.hint} is null and ${t.outcome} is null)
        or (${t.kind} = ${literal(KnowledgeItemKindSchema.enum.lesson)}
          and ${t.fromEntityId} is null and ${t.toEntityId} is null and ${t.label} is null
          and ${t.server} is not null and ${t.tool} is not null and ${t.question} is not null
          and ${t.hint} is not null and ${t.outcome} is not null)
        or (${t.kind} = ${literal(KnowledgeItemKindSchema.enum.searched_nothing)}
          and ${t.fromEntityId} is null and ${t.toEntityId} is null and ${t.label} is null
          and ${t.server} is not null and ${t.tool} is not null and ${t.question} is not null
          and ${t.hint} is null and ${t.outcome} is null)`,
    ),
  ],
);

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

/**
 * The question of a session and its vector (KD-6). An array, not `vector`: the row is read by key,
 * never searched, so the table does not depend on the extension. Null vector — embeddings refused.
 */
export const agentKnowledgeQuestions = app.table('agent_knowledge_questions', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => agentSessions.taskId, { onDelete: 'cascade' }),
  /** `task` or the id of the employee's message. */
  source: text('source').notNull(),
  model: text('model'),
  vector: real('vector').array(),
  createdAt: createdAt(),
});

/** The vector row of a deep agent (KD-8): its pass in progress and the last embeddings outcome. */
export const agentKnowledgeEmbedding = app.table(
  'agent_knowledge_embedding',
  {
    recordId: uuid('record_id')
      .primaryKey()
      .references(() => libraryRecords.id, { onDelete: 'cascade' }),
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

/**
 * The pgvector store of `KnowledgeVectorStore` (KD-8): the collection is the deep agent, one vector
 * per record key, carrying its model (Invariant 11).
 */
export const agentKnowledgeVectors = app.table(
  'agent_knowledge_vectors',
  {
    recordId: uuid('record_id')
      .notNull()
      .references(() => libraryRecords.id, { onDelete: 'cascade' }),
    /** Record key: `e12`, `r7`. */
    key: text('key').notNull(),
    keyKind: text('key_kind').notNull(),
    model: text('model').notNull(),
    vector: vector('vector').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.key] }),
    check(
      'agent_knowledge_vectors_key_kind_check',
      isOneOf(t.keyKind, KnowledgeItemTypeSchema.options),
    ),
  ],
);

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

// ---------------------------------------------------------------------------------------------
// Audit (enterprise-access/design-identity.md, KD-7). Written only by `AuditLog` of `apps/api`;
// kinds are open: every part adds its own.
// ---------------------------------------------------------------------------------------------

export const auditEvents = app.table('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  /** Employee id or `system`. */
  actor: text('actor').notNull(),
  objectType: text('object_type'),
  objectId: text('object_id'),
  /** Secrets and passwords are already masked by `AuditLog`. */
  before: jsonb('before'),
  after: jsonb('after'),
  outcome: text('outcome').notNull(),
  reason: text('reason'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
