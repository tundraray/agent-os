import {
  DEDUP_KEY_PREFIX,
  DeliveryStatusSchema,
  EVENT_PAYLOAD_MAX_BYTES,
  EVIDENCE_CONTENT_MAX_BYTES,
  InvestigationStatusSchema,
  KnowledgeStatusSchema,
  TaskEdgeKindSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
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
 * declared here; feature tables carry their prefix (`research_`). drizzle-kit generates the
 * migrations in `packages/db/migrations/` from this module.
 *
 * CHECK domains are built from the contract enums (AC-RT-8), never duplicated here.
 * The cascade starts at `research_investigations`: every FK is `ON DELETE CASCADE`.
 */
export const app = pgSchema('app');

/** `bytea` column carried as a Node `Buffer` (KD-6). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** SQL string literal of a code constant (enum value, prefix). */
const literal = (value: string): SQL =>
  sql.raw(`'${value.replaceAll("'", "''")}'`);

/** `column IN (...)` over the values of a contract enum. */
const isOneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.join(values.map(literal), sql`, `)})`;

/** Task statuses that keep a `dedup_key` taken: a new task is admitted only after `failed` or `cancelled`. */
const LIVE_TASK_STATUSES = TaskStatusSchema.exclude([
  'failed',
  'cancelled',
]).options;
/** Task statuses that are not final: the deadline timer still applies. */
const UNFINISHED_TASK_STATUSES = TaskStatusSchema.extract([
  'queued',
  'running',
  'waiting',
]).options;

export const researchInvestigations = app.table(
  'research_investigations',
  {
    investigationId: uuid('investigation_id').primaryKey(),
    resourceId: text('resource_id').notNull(),
    threadId: text('thread_id').notNull(),
    query: text('query').notNull(),
    status: text('status').notNull().default('active'),
    maxTasks: integer('max_tasks').notNull(),
    tasksReserved: integer('tasks_reserved').notNull().default(0),
    maxToolCalls: integer('max_tool_calls').notNull(),
    toolCallsReserved: integer('tool_calls_reserved').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'research_investigations_status_check',
      isOneOf(t.status, InvestigationStatusSchema.options),
    ),
    check(
      'research_investigations_tasks_reserved_check',
      sql`${t.tasksReserved} >= 0 and ${t.tasksReserved} <= ${t.maxTasks}`,
    ),
    check(
      'research_investigations_tool_calls_reserved_check',
      sql`${t.toolCallsReserved} >= 0 and ${t.toolCallsReserved} <= ${t.maxToolCalls}`,
    ),
    check(
      'research_investigations_resource_id_check',
      sql`${t.resourceId} <> ''`,
    ),
    index('research_investigations_resource_thread_idx').on(
      t.resourceId,
      t.threadId,
    ),
  ],
);

export const researchTasks = app.table(
  'research_tasks',
  {
    taskId: uuid('task_id').primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => researchInvestigations.investigationId, {
        onDelete: 'cascade',
      }),
    // contract
    workflowType: text('workflow_type').notNull(),
    workflowVersion: integer('workflow_version').notNull(),
    input: jsonb('input').notNull(),
    inputRefs: jsonb('input_refs').notNull(),
    expectedOutput: jsonb('expected_output').notNull(),
    dedupKey: text('dedup_key').notNull(),
    // execution
    status: text('status').notNull().default('queued'),
    waitCondition: jsonb('wait_condition'),
    stateVersion: integer('state_version').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    recoveryCount: integer('recovery_count').notNull().default(0),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    // budget
    maxToolCalls: integer('max_tool_calls').notNull(),
    maxRetries: integer('max_retries').notNull(),
    deadlineMs: integer('deadline_ms').notNull(),
    maxTokens: integer('max_tokens').notNull(),
    toolCallsUsed: integer('tool_calls_used').notNull().default(0),
    retriesUsed: integer('retries_used').notNull().default(0),
    attemptToolCalls: integer('attempt_tool_calls').notNull().default(0),
    attemptRetries: integer('attempt_retries').notNull().default(0),
    // result
    outcome: jsonb('outcome'),
    failureReason: jsonb('failure_reason'),
    outputRefs: uuid('output_refs')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    checkpoint: jsonb('checkpoint'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('research_tasks_investigation_task_key').on(
      t.investigationId,
      t.taskId,
    ),
    uniqueIndex('research_tasks_live_dedup_key_idx')
      .on(t.investigationId, t.dedupKey)
      .where(isOneOf(t.status, LIVE_TASK_STATUSES)),
    check(
      'research_tasks_status_check',
      isOneOf(t.status, TaskStatusSchema.options),
    ),
    check(
      'research_tasks_wait_condition_check',
      sql`(${t.status} = ${literal(TaskStatusSchema.enum.waiting)}) = (${t.waitCondition} is not null)`,
    ),
    check(
      'research_tasks_tool_calls_check',
      sql`${t.toolCallsUsed} >= 0 and ${t.attemptToolCalls} >= 0 and ${t.toolCallsUsed} + ${t.attemptToolCalls} <= ${t.maxToolCalls}`,
    ),
    check(
      'research_tasks_retries_check',
      sql`${t.retriesUsed} >= 0 and ${t.attemptRetries} >= 0 and ${t.retriesUsed} + ${t.attemptRetries} <= ${t.maxRetries}`,
    ),
    check(
      'research_tasks_dedup_key_check',
      sql`${t.dedupKey} like ${literal(`${DEDUP_KEY_PREFIX}%`)}`,
    ),
    index('research_tasks_queued_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = ${literal(TaskStatusSchema.enum.queued)}`),
    index('research_tasks_running_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = ${literal(TaskStatusSchema.enum.running)}`),
    index('research_tasks_unfinished_deadline_idx')
      .on(t.deadlineAt)
      .where(isOneOf(t.status, UNFINISHED_TASK_STATUSES)),
  ],
);

export const researchTaskDependencies = app.table(
  'research_task_dependencies',
  {
    investigationId: uuid('investigation_id').notNull(),
    taskId: uuid('task_id').notNull(),
    dependsOnTaskId: uuid('depends_on_task_id').notNull(),
    kind: text('kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId, t.kind] }),
    foreignKey({
      name: 'research_task_dependencies_task_fk',
      columns: [t.investigationId, t.taskId],
      foreignColumns: [researchTasks.investigationId, researchTasks.taskId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'research_task_dependencies_depends_on_fk',
      columns: [t.investigationId, t.dependsOnTaskId],
      foreignColumns: [researchTasks.investigationId, researchTasks.taskId],
    }).onDelete('cascade'),
    check(
      'research_task_dependencies_kind_check',
      isOneOf(t.kind, TaskEdgeKindSchema.options),
    ),
    check(
      'research_task_dependencies_no_loop_check',
      sql`${t.taskId} <> ${t.dependsOnTaskId}`,
    ),
    index('research_task_dependencies_depends_on_idx').on(t.dependsOnTaskId),
  ],
);

export const researchTaskSubscribers = app.table(
  'research_task_subscribers',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => researchTasks.taskId, { onDelete: 'cascade' }),
    subscriberKey: text('subscriber_key').notNull(),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    notifiedEventId: uuid('notified_event_id'),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.subscriberKey] })],
);

export const researchEvents = app.table(
  'research_events',
  {
    eventId: uuid('event_id').primaryKey(),
    /** Insertion order only; carries no meaning across investigations. */
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => researchInvestigations.investigationId, {
        onDelete: 'cascade',
      }),
    taskId: uuid('task_id'),
    causationId: uuid('causation_id'),
    correlationId: uuid('correlation_id').notNull(),
    stateRevision: integer('state_revision').notNull(),
    payloadRef: text('payload_ref'),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'research_events_payload_size_check',
      sql`octet_length(${t.payload}::text) <= ${sql.raw(String(EVENT_PAYLOAD_MAX_BYTES))}`,
    ),
    index('research_events_correlation_seq_idx').on(t.correlationId, t.seq),
    index('research_events_causation_idx').on(t.causationId),
    index('research_events_task_seq_idx').on(t.taskId, t.seq),
    index('research_events_investigation_idx').on(t.investigationId),
  ],
);

export const researchEventDeliveries = app.table(
  'research_event_deliveries',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => researchEvents.eventId, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.consumer] }),
    check(
      'research_event_deliveries_status_check',
      isOneOf(t.status, DeliveryStatusSchema.options),
    ),
    index('research_event_deliveries_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = ${literal(DeliveryStatusSchema.enum.pending)}`),
  ],
);

export const researchEvidence = app.table(
  'research_evidence',
  {
    evidenceId: uuid('evidence_id').primaryKey(),
    investigationId: uuid('investigation_id').notNull(),
    taskId: uuid('task_id').notNull(),
    evidenceKey: text('evidence_key').notNull(),
    writtenByAttempt: integer('written_by_attempt').notNull(),
    knowledgeStatus: text('knowledge_status').notNull().default('observed'),
    scope: text('scope'),
    basis: text('basis'),
    evidenceVersion: integer('evidence_version'),
    /** Immutable: a trigger (custom migration) rejects any change. */
    provenance: jsonb('provenance').notNull(),
    coverage: jsonb('coverage').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'research_evidence_task_fk',
      columns: [t.investigationId, t.taskId],
      foreignColumns: [researchTasks.investigationId, researchTasks.taskId],
    }).onDelete('cascade'),
    unique('research_evidence_task_key').on(t.taskId, t.evidenceKey),
    check(
      'research_evidence_knowledge_status_check',
      isOneOf(t.knowledgeStatus, KnowledgeStatusSchema.options),
    ),
    check(
      'research_evidence_supported_check',
      sql`${t.knowledgeStatus} <> ${literal(KnowledgeStatusSchema.enum.supported)} or (${t.scope} is not null and ${t.basis} is not null and ${t.evidenceVersion} is not null)`,
    ),
  ],
);

export const researchEvidenceContents = app.table(
  'research_evidence_contents',
  {
    evidenceId: uuid('evidence_id')
      .primaryKey()
      .references(() => researchEvidence.evidenceId, { onDelete: 'cascade' }),
    mediaType: text('media_type').notNull(),
    bytes: bytea('bytes').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
  },
  (t) => [
    check(
      'research_evidence_contents_byte_size_check',
      sql`${t.byteSize} = octet_length(${t.bytes}) and ${t.byteSize} <= ${sql.raw(String(EVIDENCE_CONTENT_MAX_BYTES))}`,
    ),
  ],
);
