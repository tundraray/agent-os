import {
  ABSOLUTE_MINUTES_DEFAULT,
  ABSOLUTE_MINUTES_MAX,
  ABSOLUTE_MINUTES_MIN,
  DecisionStatusSchema,
  DeliveryStatusSchema,
  DraftStateSchema,
  EVENT_PAYLOAD_MAX_BYTES,
  GrantEffectSchema,
  GrantTargetKindSchema,
  HistoryEntryKindSchema,
  IDLE_MINUTES_DEFAULT,
  IDLE_MINUTES_MAX,
  IDLE_MINUTES_MIN,
  McpServerModeSchema,
  MessageStatusSchema,
  ProviderTypeSchema,
  RECORD_MAX_TURNS_DEFAULT,
  RECORD_MAX_TURNS_MAX,
  RECORD_MAX_TURNS_MIN,
  RecordKindSchema,
  SaveOwnRefusalSchema,
  TaskStatusSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  UserStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
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

export const agentSessions = app.table(
  'agent_sessions',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => runtimeTasks.taskId, { onDelete: 'cascade' }),
    /** Owner of the task; read only by the `task.failed` consumer. */
    ownerId: text('owner_id').notNull(),
    /** Name of the run from its snapshot (custom-agents/design-runtime.md, KD-3). */
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Model of the snapshot; every call of the session uses it. */
    model: text('model').notNull(),
    /** Task text; `restart` starts a new agent with it. */
    prompt: text('prompt').notNull(),
    /**
     * Origin of the run: the library record it started from, as it was at the start. All null for a
     * conversation's root. No FK: the record may be deleted. The snapshot itself lives only in the
     * task input (ADR-0017).
     */
    recordId: uuid('record_id'),
    recordKind: text('record_kind'),
    recordVersion: integer('record_version'),
    recordName: text('record_name'),
    authorId: uuid('author_id'),
    authorName: text('author_name'),
    builtinKey: text('builtin_key'),
    /** Executor name of a workflow step; null otherwise. */
    executor: text('executor'),
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
    createdAt: createdAt(),
  },
  (t) => [
    /** Counts the owner's runs of a record for the chat listing. */
    index('agent_sessions_owner_record_idx').on(t.ownerId, t.recordId),
  ],
);

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
    /** `{ model }` of a refusal by model (`model_not_connected`, `model_not_allowed`); null otherwise. */
    refusalDetail: jsonb('refusal_detail'),
    resultText: text('result_text'),
    /** Agent started by `start_agent`. */
    childTaskId: uuid('child_task_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** How many times a `run_code` read run has started (code-execution KD-7). */
    attempts: integer('attempts').notNull().default(0),
    /** Script output of a successful `run_code` run. */
    output: text('output'),
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

/** Full result of a successful direct MCP call, as a value for scripts (code-execution KD-5). */
export const agentToolResults = app.table(
  'agent_tool_results',
  {
    taskId: uuid('task_id').notNull(),
    callId: text('call_id').notNull(),
    value: jsonb('value').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.callId] }),
    foreignKey({
      name: 'agent_tool_results_call_fk',
      columns: [t.taskId, t.callId],
      foreignColumns: [agentToolCalls.taskId, agentToolCalls.callId],
    }).onDelete('cascade'),
  ],
);

/** Audit of the tool calls a `run_code` script made; the result is seen only by the script (code-execution KD-6). */
export const agentCodeCalls = app.table(
  'agent_code_calls',
  {
    taskId: uuid('task_id').notNull(),
    /** `callId` of the `run_code` row. */
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
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.runCallId, t.attempt, t.seq] }),
    foreignKey({
      name: 'agent_code_calls_run_call_fk',
      columns: [t.taskId, t.runCallId],
      foreignColumns: [agentToolCalls.taskId, agentToolCalls.callId],
    }).onDelete('cascade'),
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
    /** How the token was obtained; `oauth` is the only type so far. */
    tokenType: text('token_type').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.server] }),
    check('agent_mcp_accounts_token_type_check', isOneOf(t.tokenType, ['oauth'])),
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

/**
 * A record draft of a conversation (custom-agents/design-runtime.md, KD-6): written by `draft_record`
 * of the root, resolved by the conversation's route. `record_id` and `saved_record_id` have no FK:
 * the record may be deleted.
 */
export const chatDrafts = app.table(
  'chat_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    /** The `draft_record` call in the root's history the card stands at. */
    callId: text('call_id').notNull(),
    kind: text('kind').notNull(),
    /** The edited record and its version at the draft; null for a new record. */
    recordId: uuid('record_id'),
    baseVersion: integer('base_version'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    content: jsonb('content').notNull(),
    state: text('state').notNull().default(DraftStateSchema.enum.pending),
    savedRecordId: uuid('saved_record_id'),
    /** Reason of the last refused `saveOwn`; null when none. */
    refusal: text('refusal'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('chat_drafts_conversation_idx').on(t.conversationId),
    check('chat_drafts_kind_check', isOneOf(t.kind, RecordKindSchema.options)),
    check('chat_drafts_state_check', isOneOf(t.state, DraftStateSchema.options)),
    check('chat_drafts_refusal_check', isOneOf(t.refusal, SaveOwnRefusalSchema.options)),
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('identity_users_email_idx').on(t.email),
    uniqueIndex('identity_users_login_idx').on(t.login),
    check('identity_users_status_check', isOneOf(t.status, UserStatusSchema.options)),
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
    /** Employee id or `system`; null while the defaults stand. */
    updatedBy: text('updated_by'),
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
  ],
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
    index('access_grants_role_idx').on(t.roleId),
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
    /** «Максимум шагов» a new agent or workflow starts with; each record may change its own. */
    defaultMaxTurns: integer('default_max_turns').notNull().default(RECORD_MAX_TURNS_DEFAULT),
    /** Null while the default stands. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Employee id; null while the default stands. */
    updatedBy: text('updated_by'),
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
