import { z } from "zod";
import { ThreadIdSchema } from "./threads.js";

/** Max UTF-8 size of `TaskSpec.input` (16 KiB). */
export const TASK_INPUT_MAX_BYTES = 16 * 1024;
/** Max UTF-8 size of `HandlerResult.answerOrDelta` and of a checkpoint (64 KiB). */
export const TASK_OUTCOME_MAX_BYTES = 64 * 1024;
/** Max UTF-8 size of `EventEnvelope.payload` (8 KiB); larger content goes by `payloadRef`. */
export const EVENT_PAYLOAD_MAX_BYTES = 8 * 1024;
/** Max UTF-8 size of `provenance.normalizedArgs` (16 KiB). */
export const EVIDENCE_ARGS_MAX_BYTES = 16 * 1024;
/** Max size of evidence content (16 MiB). */
export const EVIDENCE_CONTENT_MAX_BYTES = 16 * 1024 * 1024;
/** Max length of an opaque `Coverage.continuation` (4 KiB). */
export const COVERAGE_CONTINUATION_MAX_LENGTH = 4 * 1024;
/** Prefix of the current `dedup_key` rule; a rule change bumps the version. */
export const DEDUP_KEY_PREFIX = "v1:";

const utf8 = new TextEncoder();

/** JSON value whose serialized UTF-8 size is at most `maxBytes`. */
const boundedJson = (maxBytes: number) =>
  z
    .json()
    .refine((value) => utf8.encode(JSON.stringify(value)).length <= maxBytes, {
      message: `JSON larger than ${maxBytes} bytes`,
    });

/** JSON object whose serialized UTF-8 size is at most `maxBytes`. */
const boundedJsonObject = (maxBytes: number) =>
  z
    .record(z.string(), z.json())
    .refine((value) => utf8.encode(JSON.stringify(value)).length <= maxBytes, {
      message: `JSON larger than ${maxBytes} bytes`,
    });

const CounterSchema = z.number().int().min(0);

// ---------------------------------------------------------------------------
// Enums (exported as values: the CHECK domains of schema `app` are built from them, AC-RT-8)
// ---------------------------------------------------------------------------

/** Status of a research task. `succeeded`, `failed` and `cancelled` are terminal. */
export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Status of an investigation. `completed`, `failed` and `cancelled` are closed: the only way out
 * of them is `deleting` when the thread is deleted.
 */
export const InvestigationStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "cancelled",
  "deleting",
]);
export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>;

/** Status of an event delivery to a consumer (outbox). */
export const DeliveryStatusSchema = z.enum([
  "pending",
  "done",
  "needs_attention",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** Kind of an edge between tasks: start after `succeeded`, or wake a waiting task. */
export const TaskEdgeKindSchema = z.enum(["depends_on", "waits_for"]);
export type TaskEdgeKind = z.infer<typeof TaskEdgeKindSchema>;

/** Knowledge status of evidence; `putEvidence` writes `observed`. */
export const KnowledgeStatusSchema = z.enum([
  "observed",
  "candidate",
  "supported",
  "refuted",
  "unknown",
  "stale",
]);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;

/**
 * Class of a task failure. Only the runtime sets `dependency_failed`, `recovery_exhausted`
 * and `internal`; `budget_exhausted` and `validation_rejected` come only from a handler.
 */
export const FailureClassSchema = z.enum([
  "transport_protocol",
  "tool_error",
  "deadline",
  "cancelled",
  "dependency_failed",
  "budget_exhausted",
  "recovery_exhausted",
  "snapshot_changed",
  "allowlist_rejected",
  "validation_rejected",
  "internal",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

/** Outcome of `TaskScheduler.propose`. */
export const ProposeOutcomeSchema = z.enum([
  "created",
  "subscribed",
  "rejected",
]);
export type ProposeOutcome = z.infer<typeof ProposeOutcomeSchema>;

/** Reason of a rejected proposal. */
export const ProposeRejectReasonSchema = z.enum([
  "invalid_spec",
  "unknown_workflow",
  "unknown_dependency",
  "self_dependency",
  "wait_cycle",
  "budget_exhausted",
  "investigation_inactive",
]);
export type ProposeRejectReason = z.infer<typeof ProposeRejectReasonSchema>;

/** Reason of a refused tool call reservation. */
export const ToolCallDenyReasonSchema = z.enum([
  "tool_calls_exhausted",
  "retries_exhausted",
  "not_current_attempt",
  "cancel_requested",
]);
export type ToolCallDenyReason = z.infer<typeof ToolCallDenyReasonSchema>;

/** `kind` of `TaskContext.signal.reason`: why the attempt was aborted. */
export const AbortReasonKindSchema = z.enum([
  "cancelled",
  "deadline",
  "shutdown",
  "lease_lost",
  /** The attempt ran past `RUNTIME_ATTEMPT_MS` before the task's deadline: it is retried as a lost one. */
  "attempt_timeout",
]);
export type AbortReasonKind = z.infer<typeof AbortReasonKindSchema>;

/** Event types written by the runtime, `schemaVersion` 1. */
export const RuntimeEventTypeSchema = z.enum([
  "InvestigationCreated",
  "InvestigationCancelled",
  /** The investigation closed `completed` after its controller task succeeded; no payload beyond the envelope. */
  "InvestigationCompleted",
  /** The investigation closed `failed` after its controller task failed; no payload beyond the envelope. */
  "InvestigationFailed",
  "TaskQueued",
  "TaskStarted",
  "TaskWaiting",
  "ToolCallReserved",
  "EvidenceStored",
  "TaskSucceeded",
  "TaskFailed",
  "TaskCancelled",
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

/** Reason carried by a `TaskQueued` event. */
export const TaskQueuedReasonSchema = z.enum([
  "admitted",
  "woken",
  "recovered",
  "released",
]);
export type TaskQueuedReason = z.infer<typeof TaskQueuedReasonSchema>;

// ---------------------------------------------------------------------------
// Investigation
// ---------------------------------------------------------------------------

/** Owner of an investigation: the user, as `resource` in Mastra Memory. */
export const ResourceIdSchema = z.string().min(1).max(255);

/** Input of `InvestigationService.create`. */
export const InvestigationSpecSchema = z.object({
  resourceId: ResourceIdSchema,
  threadId: ThreadIdSchema,
  query: z.string().min(1).max(10_000),
  budget: z.object({
    maxTasks: z.number().int().min(1).max(1_000),
    maxToolCalls: z.number().int().min(1).max(10_000),
  }),
});
export type InvestigationSpec = z.infer<typeof InvestigationSpecSchema>;

// ---------------------------------------------------------------------------
// Coverage and FailureReason
// ---------------------------------------------------------------------------

/**
 * Coverage of a result. `totalRelation` is set exactly when `totalMatched` is known;
 * `returned ≤ totalMatched` when the total is exact; `truncated` implies `partial`.
 * The rule for `complete` is owned by `mcp-source`; the runtime checks the schema.
 */
export const CoverageSchema = z
  .object({
    completeness: z.enum(["complete", "partial"]),
    totalMatched: CounterSchema.nullable(),
    totalRelation: z.enum(["eq", "gte"]).nullable(),
    returned: CounterSchema,
    truncated: z.boolean(),
    continuation: z.string().max(COVERAGE_CONTINUATION_MAX_LENGTH).nullable(),
  })
  .superRefine((coverage, ctx) => {
    if (
      (coverage.totalMatched === null) !==
      (coverage.totalRelation === null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["totalRelation"],
        message:
          "totalRelation is required with totalMatched and null without it",
      });
    }
    if (
      coverage.totalRelation === "eq" &&
      coverage.totalMatched !== null &&
      coverage.returned > coverage.totalMatched
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["returned"],
        message: "returned exceeds an exact totalMatched",
      });
    }
    if (coverage.truncated && coverage.completeness !== "partial") {
      ctx.addIssue({
        code: "custom",
        path: ["completeness"],
        message: "a truncated result is partial",
      });
    }
  });
export type Coverage = z.infer<typeof CoverageSchema>;

/** Reason of a `failed` or `cancelled` task. `dependency_failed` names the direct and root cause. */
export const FailureReasonSchema = z
  .object({
    class: FailureClassSchema,
    code: z.string().min(1).max(100),
    message: z.string().max(2_000),
    cause: z.string().max(500).nullable(),
    attempt: CounterSchema,
    toolCalls: CounterSchema,
    retries: CounterSchema,
    dependencyTaskId: z.uuid().optional(),
    rootCauseTaskId: z.uuid().optional(),
  })
  .superRefine((failure, ctx) => {
    if (failure.class !== "dependency_failed") return;
    for (const key of ["dependencyTaskId", "rootCauseTaskId"] as const) {
      if (failure[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required for dependency_failed`,
        });
      }
    }
  });
export type FailureReason = z.infer<typeof FailureReasonSchema>;

// ---------------------------------------------------------------------------
// TaskSpec and ProposeResult
// ---------------------------------------------------------------------------

/** Input reference with the data snapshot it was read at. */
export const InputRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1).max(500),
  snapshot: z.string().min(1).max(200),
});
export type InputRef = z.infer<typeof InputRefSchema>;

/** Expected result, fixed before the task starts. */
export const ExpectedOutputSchema = z.object({
  description: z.string().min(1).max(2_000),
  completeness: z.enum(["all", "sample"]),
});
export type ExpectedOutput = z.infer<typeof ExpectedOutputSchema>;

/** Limits of one task, across all of its attempts. `maxTokens` is spent by `deep-research`. */
export const TaskBudgetSchema = z.object({
  maxToolCalls: z.number().int().min(1),
  maxRetries: CounterSchema,
  deadlineMs: z.number().int().min(1_000).max(3_600_000),
  maxTokens: CounterSchema,
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

/**
 * Input of `TaskScheduler.propose`. `input` is validated again by the handler's `inputSchema`;
 * workflow existence and the active investigation are checked at admission.
 */
export const TaskSpecSchema = z.object({
  investigationId: z.uuid(),
  workflowType: z.string().min(1).max(100),
  workflowVersion: z.number().int().min(1),
  input: boundedJsonObject(TASK_INPUT_MAX_BYTES),
  inputRefs: z.array(InputRefSchema),
  expectedOutput: ExpectedOutputSchema,
  dependsOn: z.array(z.uuid()),
  budget: TaskBudgetSchema,
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** Second argument of `propose`: who requested the task, stored as `subscriber_key`. */
export const RequesterKeySchema = z.string().min(1).max(200);
export type RequesterKey = z.infer<typeof RequesterKeySchema>;

/**
 * Result of `TaskScheduler.propose`; a refusal is a value, not an exception.
 * `details` holds the field path, the tasks of the cycle or the exhausted limit (`tasks`, `tool_calls`).
 */
export const ProposeResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal(["created", "subscribed"]),
    taskId: z.uuid(),
    status: TaskStatusSchema,
  }),
  z.object({
    outcome: z.literal("rejected"),
    reason: ProposeRejectReasonSchema,
    details: z.record(z.string(), z.unknown()),
  }),
]);
export type ProposeResult = z.infer<typeof ProposeResultSchema>;

// ---------------------------------------------------------------------------
// Handler port
// ---------------------------------------------------------------------------

/** Result of `TaskContext.reserveToolCall`: `callIndex` when granted, `reason` when refused. */
export const ToolCallGrantSchema = z.discriminatedUnion("granted", [
  z.object({ granted: z.literal(true), callIndex: CounterSchema }),
  z.object({ granted: z.literal(false), reason: ToolCallDenyReasonSchema }),
]);
export type ToolCallGrant = z.infer<typeof ToolCallGrantSchema>;

const ShortTextListSchema = z.array(z.string().max(500));

/**
 * Schema of `TaskHandler.run`'s result; the type `HandlerResult` belongs to the handler port in
 * `@agent-os/runtime`. `failed` carries `failure`; `wait` carries `waitFor`.
 */
export const HandlerResultSchema = z
  .object({
    kind: z.enum(["completed", "failed", "wait"]),
    answerOrDelta: boundedJson(TASK_OUTCOME_MAX_BYTES).nullable(),
    evidenceRefs: z.array(z.uuid()),
    coverage: CoverageSchema.nullable(),
    missingEvidence: ShortTextListSchema,
    warnings: ShortTextListSchema,
    proposedTasks: z.array(TaskSpecSchema),
    failure: FailureReasonSchema.optional(),
    waitFor: z.array(z.uuid()).optional(),
  })
  .superRefine((result, ctx) => {
    if (result.kind === "failed" && result.failure === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: "failure is required for kind failed",
      });
    }
    if (result.kind === "wait" && !result.waitFor?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["waitFor"],
        message: "waitFor is required for kind wait",
      });
    }
  });

/** Outcome of a succeeded task as stored and read (`Task.outcome`). */
export const TaskOutcomeSchema = z.object({
  answerOrDelta: boundedJson(TASK_OUTCOME_MAX_BYTES).nullable(),
  missingEvidence: ShortTextListSchema,
  warnings: ShortTextListSchema,
});
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/** A task as returned by `InvestigationService.listForThread` (AC-01.1). */
export const TaskSchema = z.object({
  taskId: z.uuid(),
  workflowType: z.string().min(1).max(100),
  workflowVersion: z.number().int().min(1),
  status: TaskStatusSchema,
  dedupKey: z.string().startsWith(DEDUP_KEY_PREFIX),
  outputRefs: z.array(z.uuid()),
  outcome: TaskOutcomeSchema.nullable(),
  coverage: CoverageSchema.nullable(),
  failureReason: FailureReasonSchema.nullable(),
  attempt: CounterSchema,
  toolCallsUsed: CounterSchema,
  retriesUsed: CounterSchema,
  subscribers: z.array(RequesterKeySchema),
});
export type Task = z.infer<typeof TaskSchema>;

/** An investigation; `tasks` is present only in the response of `listForThread`. */
export const InvestigationSchema = InvestigationSpecSchema.extend({
  investigationId: z.uuid(),
  status: InvestigationStatusSchema,
  createdAt: z.iso.datetime(),
  tasks: z.array(TaskSchema).optional(),
});
export type Investigation = z.infer<typeof InvestigationSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Envelope of an outbox event. `correlationId` is the `eventId` of `InvestigationCreated`. */
export const EventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  type: RuntimeEventTypeSchema,
  schemaVersion: z.number().int().min(1),
  investigationId: z.uuid(),
  taskId: z.uuid().nullable(),
  causationId: z.uuid().nullable(),
  correlationId: z.uuid(),
  stateRevision: CounterSchema,
  payloadRef: z
    .string()
    .regex(/^(evidence|task-outcome):.+$/)
    .nullable(),
  payload: boundedJson(EVENT_PAYLOAD_MAX_BYTES),
  createdAt: z.iso.datetime(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Where an evidence came from; immutable once stored. */
export const ProvenanceSchema = z.object({
  sourceId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  normalizedArgs: boundedJson(EVIDENCE_ARGS_MAX_BYTES),
  snapshot: z.string().min(1).max(200),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

const knowledgeFields = {
  scope: z.string().min(1).nullish(),
  basis: z.string().min(1).nullish(),
  evidenceVersion: z.number().int().min(1).nullish(),
};

type KnowledgeFields = {
  knowledgeStatus?: KnowledgeStatus;
  scope?: string | null;
  basis?: string | null;
  evidenceVersion?: number | null;
};

/** AC-03.4: `supported` evidence requires `scope`, `basis` and `evidenceVersion`. */
const requireSupportFields = (
  evidence: KnowledgeFields,
  ctx: z.RefinementCtx,
) => {
  if (evidence.knowledgeStatus !== "supported") return;
  for (const key of ["scope", "basis", "evidenceVersion"] as const) {
    if (evidence[key] == null) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required for supported evidence`,
      });
    }
  }
};

/** Input of `TaskContext.putEvidence`. Without `knowledgeStatus` the evidence is `observed`. */
export const EvidenceInputSchema = z
  .object({
    evidenceKey: z.string().min(1).max(200),
    provenance: ProvenanceSchema,
    coverage: CoverageSchema,
    content: z.object({
      mediaType: z.string().min(1),
      bytes: z
        .instanceof(Uint8Array)
        .refine((bytes) => bytes.byteLength <= EVIDENCE_CONTENT_MAX_BYTES, {
          message: `content larger than ${EVIDENCE_CONTENT_MAX_BYTES} bytes`,
        }),
    }),
    knowledgeStatus: KnowledgeStatusSchema.optional(),
    ...knowledgeFields,
  })
  .superRefine(requireSupportFields);
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

/** Reference returned by `putEvidence`. */
export const EvidenceRefSchema = z.object({
  evidenceId: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: CounterSchema,
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Stored evidence as returned by `EvidenceReader.get` (the bytes are returned alongside). */
export const EvidenceRecordSchema = z
  .object({
    ...EvidenceRefSchema.shape,
    taskId: z.uuid(),
    writtenByAttempt: CounterSchema,
    evidenceKey: z.string().min(1).max(200),
    provenance: ProvenanceSchema,
    coverage: CoverageSchema,
    mediaType: z.string().min(1),
    knowledgeStatus: KnowledgeStatusSchema,
    ...knowledgeFields,
    createdAt: z.iso.datetime(),
  })
  .superRefine(requireSupportFields);
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
