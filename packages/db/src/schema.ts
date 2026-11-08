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
 * declared here; feature tables carry their prefix (`research_`). drizzle-kit generates the
 * migrations in `packages/db/migrations/` from this module.
 *
 * CHECK domains of runtime tables are built from the contract enums (AC-RT-8), never duplicated
 * here. The engine tables (design-engine.md, Data Model) keep their domains below: the engine
 * contract lives in `@agent-os/engine`, which depends on this package, and `packages/contracts`
 * does not change for it.
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

// ---------------------------------------------------------------------------------------------
// Engine tables (design-engine.md, Data Model). Each one references its investigation and, where
// a task writes the row, that task; evidence and proposed tasks are referenced by id only.
// ---------------------------------------------------------------------------------------------

/** `sourceMode` of an investigation, fixed at start (KD-8, DC-16). */
const SOURCE_MODES = ['sources', 'model_knowledge'] as const;
/** Decision kinds of the controller (design-engine.md, Terms). */
const DECISION_KINDS = [
  'requestEvidence',
  'requestAnalysis',
  'requestVerification',
  'replan',
  'wait',
  'proposeAnswer',
  'concludeInconclusive',
] as const;
/** Verdict on a controller output: one accepted decision makes a step, a rejected one carries a reason. */
const DecisionStatus = { accepted: 'accepted', rejected: 'rejected' } as const;
/** Who took the decision: the controller model, or code without a model call (KD-8). */
const DECISION_AUTHORS = ['model', 'code'] as const;
/** Status of a claim revision (design-engine.md, State Transitions). */
const CLAIM_STATUSES = [
  'unverified',
  'supported',
  'refuted',
  'insufficient',
  'causal',
] as const;
/** Roles of `ProcessConfig.roles`, plus `agent` for the turns of an agent (design-agent-core.md, KD-2). */
const MODEL_ROLES = [
  'plan',
  'controller',
  'worker',
  'verifier',
  'synthesis',
  'agent',
] as const;
/** Ledger row status: `reserved` → `settled`, `failed` or `abandoned` (KD-4, DC-9). */
const LLM_CALL_STATUSES = [
  'reserved',
  'settled',
  'failed',
  'abandoned',
] as const;
const RESERVED: (typeof LLM_CALL_STATUSES)[number] = 'reserved';
/** Size limit of a signal payload (design-engine.md, DecisionInput: JSON up to 4 KiB). */
const SIGNAL_PAYLOAD_MAX_BYTES = 4096;

const investigationRef = () =>
  uuid('investigation_id')
    .notNull()
    .references(() => researchInvestigations.investigationId, {
      onDelete: 'cascade',
    });

export const researchEngineRuns = app.table(
  'research_engine_runs',
  {
    /** One engine row per investigation (KD-9). */
    investigationId: uuid('investigation_id')
      .primaryKey()
      .references(() => researchInvestigations.investigationId, {
        onDelete: 'cascade',
      }),
    resourceId: text('resource_id').notNull(),
    launchKey: text('launch_key').notNull(),
    processId: text('process_id').notNull(),
    processVersion: integer('process_version').notNull(),
    /** Frozen copy of the `ProcessConfig` the investigation runs on to the end (DC-15). */
    processConfig: jsonb('process_config').notNull(),
    sourceMode: text('source_mode').notNull(),
    /** Set once the controller task is proposed; a start that failed before it leaves null. */
    controllerTaskId: uuid('controller_task_id'),
    tokenBudget: integer('token_budget').notNull(),
    /** Tokens held by open reservations of the ledger. */
    tokensReserved: integer('tokens_reserved').notNull().default(0),
    /** Tokens charged by closed ledger rows: the sum of their `charged_tokens`. */
    tokensSpent: integer('tokens_spent').notNull().default(0),
    answerId: uuid('answer_id'),
    answer: jsonb('answer'),
    /**
     * Snapshot of each configured source read at start (agent-quality/design-self-check.md, KD-7);
     * null for investigations started before it was recorded (no backfill).
     */
    sourceSnapshots: jsonb('source_snapshots'),
    /**
     * Active definition memory records of each agent definition at start: id, scope and text
     * (design-agent-core.md, Data Model, DC-24); null for investigations started before it was
     * recorded (no backfill).
     */
    definitionMemorySnapshot: jsonb('definition_memory_snapshot'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('research_engine_runs_launch_key').on(t.resourceId, t.launchKey),
    check(
      'research_engine_runs_source_mode_check',
      isOneOf(t.sourceMode, SOURCE_MODES),
    ),
    check(
      'research_engine_runs_tokens_check',
      sql`${t.tokenBudget} > 0 and ${t.tokensReserved} >= 0 and ${t.tokensSpent} >= 0 and ${t.tokensSpent} <= ${t.tokenBudget}`,
    ),
    check(
      'research_engine_runs_process_version_check',
      sql`${t.processVersion} > 0`,
    ),
    check(
      'research_engine_runs_keys_check',
      sql`${t.resourceId} <> '' and ${t.launchKey} <> ''`,
    ),
    check(
      'research_engine_runs_answer_check',
      sql`(${t.answerId} is null) = (${t.answer} is null)`,
    ),
  ],
);

export const researchPlanRevisions = app.table(
  'research_plan_revisions',
  {
    investigationId: investigationRef(),
    /** Starts at 1 and grows by 1; the `maxPlanRevisions` + 1 cap comes from the frozen config. */
    revision: integer('revision').notNull(),
    plan: jsonb('plan').notNull(),
    /** Reason of the `replan` decision; null for the first revision. */
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.investigationId, t.revision] }),
    check('research_plan_revisions_revision_check', sql`${t.revision} >= 1`),
  ],
);

export const researchDecisions = app.table(
  'research_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    investigationId: investigationRef(),
    step: integer('step').notNull(),
    /** Number of the controller output within the step: retries after rejected outputs (DC-2). */
    callIndex: integer('call_index').notNull(),
    status: text('status').notNull(),
    rejectionReason: text('rejection_reason'),
    decidedBy: text('decided_by').notNull(),
    /** Null only for a rejected output without a recognised kind; the raw output stays in `decision`. */
    kind: text('kind'),
    /** The output as received; null when nothing parseable came back. */
    decision: jsonb('decision'),
    planRevision: integer('plan_revision'),
    proposedTaskIds: uuid('proposed_task_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    notAfter: timestamp('not_after', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'research_decisions_plan_revision_fk',
      columns: [t.investigationId, t.planRevision],
      foreignColumns: [
        researchPlanRevisions.investigationId,
        researchPlanRevisions.revision,
      ],
    }).onDelete('cascade'),
    unique('research_decisions_step_call_key').on(
      t.investigationId,
      t.step,
      t.callIndex,
    ),
    /** One accepted decision per step: a step repeated after a restart finds it (NFR-03). */
    uniqueIndex('research_decisions_accepted_step_idx')
      .on(t.investigationId, t.step)
      .where(sql`${t.status} = ${literal(DecisionStatus.accepted)}`),
    check(
      'research_decisions_status_check',
      isOneOf(t.status, Object.values(DecisionStatus)),
    ),
    check(
      'research_decisions_decided_by_check',
      isOneOf(t.decidedBy, DECISION_AUTHORS),
    ),
    check('research_decisions_kind_check', isOneOf(t.kind, DECISION_KINDS)),
    check(
      'research_decisions_accepted_kind_check',
      sql`${t.status} <> ${literal(DecisionStatus.accepted)} or ${t.kind} is not null`,
    ),
    check(
      'research_decisions_rejection_reason_check',
      sql`(${t.status} = ${literal(DecisionStatus.rejected)}) = (${t.rejectionReason} is not null)`,
    ),
    check(
      'research_decisions_step_check',
      sql`${t.step} >= 1 and ${t.callIndex} >= 0`,
    ),
  ],
);

export const researchSignals = app.table(
  'research_signals',
  {
    signalId: uuid('signal_id').primaryKey(),
    investigationId: investigationRef(),
    /** Kinds are registered in `createEngine`, not fixed by the schema (AC-04.2). */
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The decision whose input read the signal; null while unread. */
    readByDecisionId: uuid('read_by_decision_id').references(
      () => researchDecisions.decisionId,
      { onDelete: 'cascade' },
    ),
  },
  (t) => [
    check(
      'research_signals_payload_size_check',
      sql`octet_length(${t.payload}::text) <= ${sql.raw(String(SIGNAL_PAYLOAD_MAX_BYTES))}`,
    ),
    index('research_signals_unread_idx')
      .on(t.investigationId, t.recordedAt)
      .where(sql`${t.readByDecisionId} is null`),
  ],
);

export const researchClaims = app.table(
  'research_claims',
  {
    claimRevisionId: uuid('claim_revision_id').primaryKey(),
    /** Insertion order: the latest revision of a claim has the highest `seq`. */
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    investigationId: investigationRef(),
    /** The claim across its revisions. */
    claimId: uuid('claim_id').notNull(),
    /** Task that wrote the revision, and the claim's number in that task's output. */
    taskId: uuid('task_id').notNull(),
    claimIndex: integer('claim_index').notNull(),
    text: text('text').notNull(),
    atoms: jsonb('atoms').notNull(),
    evidenceIds: uuid('evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    coverage: jsonb('coverage'),
    /** Pages and record numbers the claim rests on; null on revisions written before agent-quality. */
    pointer: jsonb('pointer'),
    /** Type from the verifier's assessment; set on check revisions only. Values come from the engine's closed schema. */
    claimType: text('claim_type'),
    /** The verifier's assessment and the broken-form flag; set on check revisions only. */
    assessment: jsonb('assessment'),
    /** Confidence group of a `supported` check revision; values come from the calibration table. */
    confidence: text('confidence'),
    status: text('status').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'research_claims_task_fk',
      columns: [t.investigationId, t.taskId],
      foreignColumns: [researchTasks.investigationId, researchTasks.taskId],
    }).onDelete('cascade'),
    /** A retried attempt that reuses the checkpointed model output adds no copy (invariant 3). */
    unique('research_claims_task_claim_key').on(t.taskId, t.claimIndex),
    check('research_claims_status_check', isOneOf(t.status, CLAIM_STATUSES)),
    check('research_claims_claim_index_check', sql`${t.claimIndex} >= 0`),
    index('research_claims_claim_seq_idx').on(t.claimId, t.seq),
    index('research_claims_investigation_idx').on(t.investigationId),
  ],
);

export const researchLlmCalls = app.table(
  'research_llm_calls',
  {
    callId: uuid('call_id').primaryKey(),
    investigationId: investigationRef(),
    taskId: uuid('task_id').notNull(),
    /** Attempt of the task that reserved; a reservation left by an earlier attempt is abandoned (DC-9). */
    attempt: integer('attempt').notNull(),
    role: text('role').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull().default(RESERVED),
    reservedTokens: integer('reserved_tokens').notNull(),
    /** Provider's count of the package before the call (DC-13). */
    countedInputTokens: integer('counted_input_tokens').notNull(),
    /** Usage the provider reported; null while reserved or when it reported none. */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    /** Tokens charged to the budget on close. */
    chargedTokens: integer('charged_tokens'),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'research_llm_calls_task_fk',
      columns: [t.investigationId, t.taskId],
      foreignColumns: [researchTasks.investigationId, researchTasks.taskId],
    }).onDelete('cascade'),
    check(
      'research_llm_calls_status_check',
      isOneOf(t.status, LLM_CALL_STATUSES),
    ),
    check('research_llm_calls_role_check', isOneOf(t.role, MODEL_ROLES)),
    check(
      'research_llm_calls_closed_check',
      sql`(${t.status} = ${literal(RESERVED)}) = (${t.closedAt} is null) and (${t.closedAt} is null) = (${t.chargedTokens} is null)`,
    ),
    check(
      'research_llm_calls_tokens_check',
      sql`${t.reservedTokens} > 0 and ${t.countedInputTokens} >= 0 and ${t.attempt} >= 1 and (${t.chargedTokens} is null or ${t.chargedTokens} >= 0)`,
    ),
    index('research_llm_calls_investigation_idx').on(t.investigationId),
    index('research_llm_calls_reserved_task_idx')
      .on(t.taskId)
      .where(sql`${t.status} = ${literal(RESERVED)}`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Transcript table (agent-quality/design-self-check.md, Data Model, KD-1): one row per model call.
// A call inside an investigation is bound one to one to its ledger row; a call outside one
// (`Engine.assess`) is bound to an investigation of the same database, to a self-check run, or both.
// ---------------------------------------------------------------------------------------------

/** Roles of a transcript: the process roles plus the self-check judge (Contract `Transcript`). */
const TRANSCRIPT_ROLES = [...MODEL_ROLES, 'judge'] as const;
/**
 * Outcomes stored on close. A row without one is `open`; `abandoned` is not stored but read from
 * the ledger row whose reservation was abandoned (Contract `Transcript`).
 */
const TRANSCRIPT_OUTCOMES = [
  'answered',
  'invalid_output',
  'provider_error',
] as const;

export const researchLlmTranscripts = app.table(
  'research_llm_transcripts',
  {
    /** Equals the ledger `call_id` for a call inside an investigation. */
    callId: uuid('call_id').primaryKey(),
    /** One-to-one link to the ledger row; null for a call outside an investigation. */
    llmCallId: uuid('llm_call_id')
      .unique('research_llm_transcripts_llm_call_key')
      .references(() => researchLlmCalls.callId, { onDelete: 'cascade' }),
    investigationId: uuid('investigation_id').references(
      () => researchInvestigations.investigationId,
      { onDelete: 'cascade' },
    ),
    taskId: uuid('task_id'),
    attempt: integer('attempt'),
    /** Self-check run that made a call outside an investigation; its format belongs to the program. */
    selfCheckRunId: text('self_check_run_id'),
    role: text('role').notNull(),
    /** Agent of an `Engine.assessAgent` turn, which has no run row; null for every other call. */
    agentName: text('agent_name'),
    model: text('model').notNull(),
    /** First 12 hex digits of the SHA-256 of the prompt template (KD-2). */
    promptVersion: text('prompt_version').notNull(),
    /** Instructions and messages as sent to the provider, with their provider options. */
    input: jsonb('input').notNull(),
    /** Response object and finish reason; null while the call is open. */
    response: jsonb('response'),
    /** Null while the call is open. */
    outcome: text('outcome'),
    inputTokens: integer('input_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'research_llm_transcripts_role_check',
      isOneOf(t.role, TRANSCRIPT_ROLES),
    ),
    check(
      'research_llm_transcripts_outcome_check',
      isOneOf(t.outcome, TRANSCRIPT_OUTCOMES),
    ),
    check(
      'research_llm_transcripts_binding_check',
      sql`${t.investigationId} is not null or ${t.selfCheckRunId} is not null`,
    ),
    check(
      'research_llm_transcripts_ledger_check',
      sql`(${t.llmCallId} is null or (${t.llmCallId} = ${t.callId} and ${t.investigationId} is not null)) and (${t.llmCallId} is null) = (${t.taskId} is null) and (${t.taskId} is null) = (${t.attempt} is null)`,
    ),
    check(
      'research_llm_transcripts_closed_check',
      sql`(${t.outcome} is null) = (${t.closedAt} is null) and (${t.response} is null or ${t.outcome} is not null)`,
    ),
    check(
      'research_llm_transcripts_prompt_version_check',
      sql`${t.promptVersion} ~ '^[0-9a-f]{12}$'`,
    ),
    index('research_llm_transcripts_investigation_idx').on(
      t.investigationId,
      t.createdAt,
    ),
    index('research_llm_transcripts_self_check_run_idx')
      .on(t.selfCheckRunId, t.createdAt)
      .where(sql`${t.selfCheckRunId} is not null`),
    index('research_llm_transcripts_created_idx').on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------------------------
// Chat entry table (design-chat-entry.md, Data Model, KD-3). The only FK is to the investigation;
// rows without one are removed by the thread's `purge` hook (KD-7).
// ---------------------------------------------------------------------------------------------

/** How the launch started: research mode on the user message, or a proposal of the agent. */
const LAUNCH_MODES = ['explicit', 'proposal'] as const;
const EXPLICIT: (typeof LAUNCH_MODES)[number] = 'explicit';
/** States of a launch row (design-chat-entry.md, State Transitions). */
const LAUNCH_STATES = [
  'proposed',
  'launching',
  'running',
  'answer_pending',
  'answered',
  'answer_reappend',
  'declined',
  'superseded',
  'failed',
  'stopped',
  'discarded',
] as const;
/** States reached only through a started investigation: the row carries it and its controller task. */
const STARTED_LAUNCH_STATES = [
  'running',
  'answer_pending',
  'answered',
  'answer_reappend',
] as const satisfies readonly (typeof LAUNCH_STATES)[number][];
/** States whose answer the delivery loop writes into the thread (KD-4). */
const ANSWER_DUE_LAUNCH_STATES = [
  'answer_pending',
  'answer_reappend',
] as const satisfies readonly (typeof LAUNCH_STATES)[number][];

export const researchChatLaunches = app.table(
  'research_chat_launches',
  {
    /** `toolCallId` of the `deepResearch` call that started or proposed the research. */
    launchKey: text('launch_key').primaryKey(),
    resourceId: text('resource_id').notNull(),
    threadId: text('thread_id').notNull(),
    mode: text('mode').notNull(),
    goal: text('goal').notNull(),
    tokenBudget: integer('token_budget').notNull(),
    /** Id of the user message that carried research mode; null for a proposal. */
    userMessageId: text('user_message_id'),
    state: text('state').notNull(),
    investigationId: uuid('investigation_id').references(
      () => researchInvestigations.investigationId,
      { onDelete: 'cascade' },
    ),
    controllerTaskId: uuid('controller_task_id'),
    /** Copied once from `InvestigationView` after the start; null before it (invariant 6, KD-8). */
    sourceMode: text('source_mode'),
    createdAt: createdAt(),
    /** When the investigation ended; orders the answers of a thread (invariant 5). */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    /** First failed answer write: the give-up window counts from it (DC-4). */
    appendFailedAt: timestamp('append_failed_at', { withTimezone: true }),
    nextAppendAt: timestamp('next_append_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'research_chat_launches_mode_check',
      isOneOf(t.mode, LAUNCH_MODES),
    ),
    check(
      'research_chat_launches_state_check',
      isOneOf(t.state, LAUNCH_STATES),
    ),
    check(
      'research_chat_launches_source_mode_check',
      isOneOf(t.sourceMode, SOURCE_MODES),
    ),
    check(
      'research_chat_launches_keys_check',
      sql`${t.launchKey} <> '' and ${t.resourceId} <> '' and ${t.threadId} <> ''`,
    ),
    check(
      'research_chat_launches_token_budget_check',
      sql`${t.tokenBudget} > 0`,
    ),
    check(
      'research_chat_launches_user_message_check',
      sql`(${t.mode} = ${literal(EXPLICIT)}) = (${t.userMessageId} is not null)`,
    ),
    check(
      'research_chat_launches_started_check',
      sql`not (${isOneOf(t.state, STARTED_LAUNCH_STATES)}) or (${t.investigationId} is not null and ${t.controllerTaskId} is not null)`,
    ),
    check(
      'research_chat_launches_source_mode_investigation_check',
      sql`${t.sourceMode} is null or ${t.investigationId} is not null`,
    ),
    index('research_chat_launches_thread_created_idx').on(
      t.resourceId,
      t.threadId,
      t.createdAt,
    ),
    index('research_chat_launches_controller_task_idx')
      .on(t.controllerTaskId)
      .where(sql`${t.controllerTaskId} is not null`),
    index('research_chat_launches_investigation_idx')
      .on(t.investigationId)
      .where(sql`${t.investigationId} is not null`),
    index('research_chat_launches_answer_due_idx')
      .on(t.finishedAt)
      .where(isOneOf(t.state, ANSWER_DUE_LAUNCH_STATES)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Chat run marks (agent-quality/design-lifecycle.md, Data Model, KD-6). No FK to the thread:
// threads live in Mastra's tables; the run registry removes its own and expired rows.
// ---------------------------------------------------------------------------------------------

export const chatThreadRuns = app.table(
  'chat_thread_runs',
  {
    /** One row per agent reply in flight. */
    runId: uuid('run_id').primaryKey(),
    threadId: text('thread_id').notNull(),
    /** The run counts only while its lease has not expired; the owning instance extends it. */
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
    }).notNull(),
  },
  (t) => [
    check('chat_thread_runs_thread_id_check', sql`${t.threadId} <> ''`),
    index('chat_thread_runs_thread_idx').on(t.threadId),
    index('chat_thread_runs_lease_idx').on(t.leaseExpiresAt),
  ],
);

// ---------------------------------------------------------------------------------------------
// Agent tables (agent-runtime/design-agent-core.md, Data Model, KD-2). Runs, session messages,
// tool calls and investigation memory are removed with their investigation (AC-03.4); the tool
// call audit and the definition memory reference no investigation and outlive it.
// ---------------------------------------------------------------------------------------------

/** States of a tool call (design-agent-core.md, «Как исполняется вызов инструмента»). */
const TOOL_CALL_STATES = [
  'requested',
  'starting',
  'waiting',
  'done',
  'rejected',
] as const;
const WAITING: (typeof TOOL_CALL_STATES)[number] = 'waiting';
const REJECTED: (typeof TOOL_CALL_STATES)[number] = 'rejected';
/** Kinds of an investigation memory note (Contract, `memory_write`). */
const MEMORY_NOTE_KINDS = ['finding', 'tried', 'dead_end', 'note'] as const;
/** Scopes of a definition memory record: the whole deployment or one user. */
const DEFINITION_MEMORY_SCOPES = ['deployment', 'user'] as const;
const USER_SCOPE: (typeof DEFINITION_MEMORY_SCOPES)[number] = 'user';
/** Size limit of a prologue input (Data Model: up to 64 KiB). */
const PROLOGUE_INPUT_MAX_BYTES = 64 * 1024;
/** Text limit of a memory note and of a definition memory record (Contract: up to 2000 characters). */
const MEMORY_TEXT_MAX_CHARS = 2000;

export const researchAgentRuns = app.table(
  'research_agent_runs',
  {
    /** Task `agent.run` or `agent.root` of the run; the run's status is the status of this task. */
    taskId: uuid('task_id').primaryKey(),
    investigationId: investigationRef(),
    agentName: text('agent_name').notNull(),
    /** Run and tool call number of the parent that called this run; both null for the root. */
    parentTaskId: uuid('parent_task_id'),
    parentCallIndex: integer('parent_call_index'),
    /** The root has depth 0. */
    depth: integer('depth').notNull(),
    /** Task text of the run; null for a form with a prologue, whose session has no task. */
    assignment: text('assignment'),
    /** Token share of the run: the `maxTokens` of its task. */
    shareTokens: integer('share_tokens').notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    sources: text('sources').array().notNull().default(sql`'{}'::text[]`),
    /** Prologue input of a form with a prologue (up to 64 KiB). */
    prologueInput: jsonb('prologue_input'),
    /** Result of a run that ended by itself, or the reason it ended without one. */
    result: jsonb('result'),
    failure: jsonb('failure'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'research_agent_runs_task_fk',
      columns: [t.investigationId, t.taskId],
      foreignColumns: [researchTasks.investigationId, researchTasks.taskId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'research_agent_runs_parent_fk',
      columns: [t.parentTaskId],
      foreignColumns: [t.taskId],
    }).onDelete('cascade'),
    check(
      'research_agent_runs_parent_check',
      sql`(${t.parentTaskId} is null) = (${t.parentCallIndex} is null) and (${t.parentTaskId} is null) = (${t.depth} = 0)`,
    ),
    check(
      'research_agent_runs_numbers_check',
      sql`${t.depth} >= 0 and ${t.shareTokens} >= 0 and (${t.parentCallIndex} is null or ${t.parentCallIndex} >= 0)`,
    ),
    check('research_agent_runs_agent_name_check', sql`${t.agentName} <> ''`),
    check(
      'research_agent_runs_prologue_input_size_check',
      sql`${t.prologueInput} is null or octet_length(${t.prologueInput}::text) <= ${sql.raw(String(PROLOGUE_INPUT_MAX_BYTES))}`,
    ),
    check(
      'research_agent_runs_ending_check',
      sql`${t.result} is null or ${t.failure} is null`,
    ),
    index('research_agent_runs_investigation_idx').on(t.investigationId),
    index('research_agent_runs_parent_idx')
      .on(t.parentTaskId)
      .where(sql`${t.parentTaskId} is not null`),
  ],
);

export const researchAgentMessages = app.table(
  'research_agent_messages',
  {
    runTaskId: uuid('run_task_id')
      .notNull()
      .references(() => researchAgentRuns.taskId, { onDelete: 'cascade' }),
    investigationId: investigationRef(),
    /** Number of the message within its run; a message is never changed once written. */
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    content: jsonb('content').notNull(),
    /** Ledger row of a model answer; null for every other message. */
    llmCallId: uuid('llm_call_id').references(() => researchLlmCalls.callId, {
      onDelete: 'cascade',
    }),
    /** Tool call whose result the message carries; null for every other message. */
    toolCallId: uuid('tool_call_id').references(
      (): AnyPgColumn => researchAgentToolCalls.id,
      { onDelete: 'cascade' },
    ),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.runTaskId, t.seq] }),
    check('research_agent_messages_seq_check', sql`${t.seq} >= 0`),
    check('research_agent_messages_kind_check', sql`${t.kind} <> ''`),
    index('research_agent_messages_investigation_idx').on(t.investigationId),
  ],
);

export const agentToolAudit = app.table(
  'agent_tool_audit',
  {
    id: uuid('id').primaryKey(),
    /** Owner of the investigation the call was made in. */
    resourceId: text('resource_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    toolName: text('tool_name').notNull(),
    /** Source the tool called; null for a tool without one. */
    sourceId: text('source_id'),
    outcome: text('outcome').notNull(),
  },
  (t) => [
    check(
      'agent_tool_audit_values_check',
      sql`${t.resourceId} <> '' and ${t.toolName} <> '' and ${t.outcome} <> ''`,
    ),
    index('agent_tool_audit_resource_recorded_idx').on(
      t.resourceId,
      t.recordedAt,
    ),
  ],
);

export const researchAgentToolCalls = app.table(
  'research_agent_tool_calls',
  {
    id: uuid('id').primaryKey(),
    investigationId: investigationRef(),
    runTaskId: uuid('run_task_id')
      .notNull()
      .references(() => researchAgentRuns.taskId, { onDelete: 'cascade' }),
    turn: integer('turn').notNull(),
    /** Number of the call within its run. */
    callIndex: integer('call_index').notNull(),
    toolName: text('tool_name').notNull(),
    arguments: jsonb('arguments').notNull(),
    state: text('state').notNull(),
    outcome: jsonb('outcome'),
    /** Code of a rejection or of a remark of the engine. */
    reason: text('reason'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Audit row written with the call's outcome; the audit outlives the call. */
    auditId: uuid('audit_id').references(() => agentToolAudit.id, {
      onDelete: 'set null',
    }),
    /** `call_agent` only: the child task, its token share and the recounted spending of its subtree. */
    childTaskId: uuid('child_task_id'),
    shareTokens: integer('share_tokens'),
    spentTokens: integer('spent_tokens'),
    /** Task specification recorded in `starting`; a retry proposes it again (KD-3). */
    taskSpec: jsonb('task_spec'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('research_agent_tool_calls_run_call_key').on(
      t.runTaskId,
      t.callIndex,
    ),
    check(
      'research_agent_tool_calls_state_check',
      isOneOf(t.state, TOOL_CALL_STATES),
    ),
    check(
      'research_agent_tool_calls_numbers_check',
      sql`${t.turn} >= 0 and ${t.callIndex} >= 0 and (${t.shareTokens} is null or ${t.shareTokens} >= 0) and (${t.spentTokens} is null or ${t.spentTokens} >= 0)`,
    ),
    check(
      'research_agent_tool_calls_tool_name_check',
      sql`${t.toolName} <> ''`,
    ),
    check(
      'research_agent_tool_calls_waiting_check',
      sql`${t.state} <> ${literal(WAITING)} or ${t.childTaskId} is not null`,
    ),
    check(
      'research_agent_tool_calls_rejected_check',
      sql`${t.state} <> ${literal(REJECTED)} or ${t.reason} is not null`,
    ),
    index('research_agent_tool_calls_investigation_idx').on(t.investigationId),
    index('research_agent_tool_calls_child_task_idx')
      .on(t.childTaskId)
      .where(sql`${t.childTaskId} is not null`),
  ],
);

export const researchAgentMemory = app.table(
  'research_agent_memory',
  {
    /** Order of writing, from a database sequence: concurrent writes get distinct numbers. */
    seq: bigint('seq', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    investigationId: investigationRef(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    /** References to records and claims of the same investigation. */
    refs: jsonb('refs').notNull().default(sql`'[]'::jsonb`),
    /** Run and agent that wrote the note. */
    runTaskId: uuid('run_task_id')
      .notNull()
      .references(() => researchAgentRuns.taskId, { onDelete: 'cascade' }),
    agentName: text('agent_name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'research_agent_memory_kind_check',
      isOneOf(t.kind, MEMORY_NOTE_KINDS),
    ),
    check(
      'research_agent_memory_text_check',
      sql`char_length(${t.text}) <= ${sql.raw(String(MEMORY_TEXT_MAX_CHARS))}`,
    ),
    index('research_agent_memory_investigation_seq_idx').on(
      t.investigationId,
      t.seq,
    ),
  ],
);

export const agentDefinitionMemory = app.table(
  'agent_definition_memory',
  {
    id: uuid('id').primaryKey(),
    processId: text('process_id').notNull(),
    agentName: text('agent_name').notNull(),
    scope: text('scope').notNull(),
    /** User of a `user` scope record; null for `deployment`. */
    userId: text('user_id'),
    text: text('text').notNull(),
    writtenBy: text('written_by').notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Soft removal: a removed record stays in the snapshots taken before it. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'agent_definition_memory_scope_check',
      isOneOf(t.scope, DEFINITION_MEMORY_SCOPES),
    ),
    check(
      'agent_definition_memory_user_check',
      sql`(${t.scope} = ${literal(USER_SCOPE)}) = (${t.userId} is not null)`,
    ),
    check(
      'agent_definition_memory_values_check',
      sql`${t.processId} <> '' and ${t.agentName} <> '' and ${t.writtenBy} <> '' and (${t.userId} is null or ${t.userId} <> '') and char_length(${t.text}) <= ${sql.raw(String(MEMORY_TEXT_MAX_CHARS))}`,
    ),
    index('agent_definition_memory_active_idx')
      .on(t.processId, t.agentName, t.scope, t.userId)
      .where(sql`${t.removedAt} is null`),
  ],
);
