import {
  EvidenceInputSchema,
  ExpectedOutputSchema,
  InputRefSchema,
  RuntimeEventTypeSchema,
  TASK_OUTCOME_MAX_BYTES,
  TaskEdgeKindSchema,
  TaskSpecSchema,
  TaskStatusSchema,
  type EvidenceInput,
  type EvidenceRef,
  type ExpectedOutput,
  type InputRef,
  type TaskBudget,
  type TaskSpec,
  type ToolCallDenyReason,
  type ToolCallGrant,
} from '@agent-os/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type Database,
  researchTaskDependencies,
  researchTasks,
} from '@agent-os/db';
import type { RuntimeLogger } from './ports.js';
import type { CrashPoints } from './crash-points.js';
import type { EventLog } from './event-log.js';
import type { EvidenceStore } from './evidence.store.js';
import type { RuntimeTx, TaskRow } from './guarded-transition.js';
import type {
  RegisterWaitResult,
  TaskContext,
  UpstreamTask,
} from './handler.registry.js';
import type { TaskScheduler } from './task-scheduler.js';
import type { TaskRepository } from './task.repository.js';

const { running, succeeded } = TaskStatusSchema.enum;
const { ToolCallReserved, EvidenceStored } = RuntimeEventTypeSchema.enum;

/** Postgres `foreign_key_violation`: the task row is gone (its investigation was deleted). */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * A write of an attempt that is no longer the task's current one, or whose task row is gone.
 * The write changed nothing (AC-RT-1).
 */
class AttemptFencedError extends Error {
  override readonly name = 'AttemptFencedError';
  readonly reason = 'fenced';
}

/**
 * Evidence or a checkpoint that breaks its schema or size limit; nothing is written. The handler
 * may end the attempt with `HandlerResult.failure` of class `validation_rejected`.
 */
class ValidationRejectedError extends Error {
  override readonly name = 'ValidationRejectedError';
  readonly failureClass = 'validation_rejected';
}

/** Services one attempt writes through; every write is its own short transaction. */
export interface TaskContextDeps {
  db: Database;
  tasks: TaskRepository;
  events: EventLog;
  evidence: EvidenceStore;
  scheduler: TaskScheduler;
  crashPoints: CrashPoints;
  logger: RuntimeLogger;
}

/** What the claim knows about the attempt. */
export interface ClaimedAttempt {
  row: TaskRow;
  upstream: UpstreamTask[];
  signal: AbortSignal;
}

const TaskInputSchema = TaskSpecSchema.shape.input;
const CheckpointSchema = z
  .json()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <=
      TASK_OUTCOME_MAX_BYTES,
    { message: `checkpoint larger than ${TASK_OUTCOME_MAX_BYTES} bytes` },
  );

/** The `postgres` error code of a driver error, also when wrapped by Drizzle (`cause`). */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Dependencies and awaited tasks of a task with their status and outputs (`ctx.upstream`),
 * ordered by edge kind and task.
 */
export async function loadUpstream(
  tx: RuntimeTx,
  taskId: string,
): Promise<UpstreamTask[]> {
  const rows = await tx
    .select({
      taskId: researchTaskDependencies.dependsOnTaskId,
      kind: researchTaskDependencies.kind,
      status: researchTasks.status,
      outputRefs: researchTasks.outputRefs,
    })
    .from(researchTaskDependencies)
    .innerJoin(
      researchTasks,
      eq(researchTasks.taskId, researchTaskDependencies.dependsOnTaskId),
    )
    .where(eq(researchTaskDependencies.taskId, taskId))
    .orderBy(
      asc(researchTaskDependencies.kind),
      asc(researchTaskDependencies.dependsOnTaskId),
    );
  return rows.map((row) => {
    const status = TaskStatusSchema.parse(row.status);
    return {
      taskId: row.taskId,
      kind: TaskEdgeKindSchema.parse(row.kind),
      status,
      outputRefs: status === succeeded ? row.outputRefs : [],
    };
  });
}

/**
 * The fenced API of one attempt (design-runtime.md, TaskHandler и TaskContext) — the only way a
 * handler writes. Each write is one transaction guarded by `status = running` and the attempt
 * (the fencing token); none is held across the handler's own work.
 */
export class AttemptContext implements TaskContext {
  readonly taskId: string;
  readonly investigationId: string;
  readonly attempt: number;
  readonly input: TaskSpec['input'];
  readonly inputRefs: readonly InputRef[];
  readonly expectedOutput: ExpectedOutput;
  readonly budget: TaskBudget;
  readonly upstream: readonly UpstreamTask[];
  readonly checkpoint: unknown;
  readonly signal: AbortSignal;
  readonly deadlineAt: Date;

  constructor(
    private readonly deps: TaskContextDeps,
    claimed: ClaimedAttempt,
  ) {
    const { row } = claimed;
    if (row.deadlineAt === null) {
      throw new Error(`Claimed task ${row.taskId} has no deadline`);
    }
    this.taskId = row.taskId;
    this.investigationId = row.investigationId;
    this.attempt = row.attempt;
    this.input = TaskInputSchema.parse(row.input);
    this.inputRefs = z.array(InputRefSchema).parse(row.inputRefs);
    this.expectedOutput = ExpectedOutputSchema.parse(row.expectedOutput);
    this.budget = {
      maxToolCalls: row.maxToolCalls,
      maxRetries: row.maxRetries,
      deadlineMs: row.deadlineMs,
      maxTokens: row.maxTokens,
    };
    this.upstream = claimed.upstream;
    this.checkpoint = row.checkpoint;
    this.signal = claimed.signal;
    this.deadlineAt = row.deadlineAt;
  }

  /**
   * The reservation rule as one guarded UPDATE: `running` with this attempt, no
   * `cancel_requested_at`, `tool_calls_used + attempt_tool_calls < max_tool_calls` and, for a
   * retry, `retries_used + attempt_retries < max_retries`. `callIndex` counts the task's calls
   * across attempts from 0.
   */
  reserveToolCall(toolName: string, retry: boolean): Promise<ToolCallGrant> {
    const t = researchTasks;
    return this.deps.db.transaction(async (tx) => {
      const row = await this.deps.tasks.transition(
        tx,
        {
          taskId: this.taskId,
          from: [running],
          attempt: this.attempt,
          where: and(
            isNull(t.cancelRequestedAt),
            sql`${t.toolCallsUsed} + ${t.attemptToolCalls} < ${t.maxToolCalls}`,
            retry
              ? sql`${t.retriesUsed} + ${t.attemptRetries} < ${t.maxRetries}`
              : undefined,
          ),
        },
        {
          kind: 'set',
          fields: {
            attemptToolCalls: sql`${t.attemptToolCalls} + 1`,
            ...(retry && { attemptRetries: sql`${t.attemptRetries} + 1` }),
          },
        },
      );
      if (!row) {
        return { granted: false, reason: await this.denyReason(tx, retry) };
      }
      const callIndex = row.toolCallsUsed + row.attemptToolCalls - 1;
      await this.deps.events.append(tx, {
        type: ToolCallReserved,
        investigationId: this.investigationId,
        taskId: this.taskId,
        causationId: await this.deps.events.causeOf(tx, {
          type: ToolCallReserved,
          taskId: this.taskId,
        }),
        stateRevision: row.stateVersion,
        payload: { attempt: this.attempt, toolName, callIndex, retry },
      });
      return { granted: true, callIndex };
    });
  }

  /**
   * Stores the evidence with its content; idempotent by the task's evidence key (a repeat returns
   * the stored ref and writes no event). The event carries the content by `payloadRef` only.
   */
  async putEvidence(evidence: EvidenceInput): Promise<EvidenceRef> {
    const parsed = EvidenceInputSchema.safeParse(evidence);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      throw new ValidationRejectedError(
        `Evidence rejected at ${issue.path.join('.')}: ${issue.message}`,
      );
    }
    const result = await this.fencedOnMissingTask(() =>
      this.deps.db.transaction(async (tx) => {
        const put = await this.deps.evidence.put(
          tx,
          { taskId: this.taskId, attempt: this.attempt },
          parsed.data,
        );
        if (put.status === 'stored')
          await this.appendEvidenceStored(tx, put.ref);
        return put;
      }),
    );
    if (result.status === 'fenced') throw this.fenced('putEvidence');
    if (result.status === 'stored') {
      this.deps.crashPoints.hit('handler.after-evidence');
    }
    return result.ref;
  }

  async saveCheckpoint(checkpoint: unknown): Promise<void> {
    const parsed = CheckpointSchema.safeParse(checkpoint);
    if (!parsed.success) {
      throw new ValidationRejectedError(
        `Checkpoint rejected: ${parsed.error.issues[0].message}`,
      );
    }
    const row = await this.deps.db.transaction((tx) =>
      this.deps.tasks.transition(
        tx,
        { taskId: this.taskId, from: [running], attempt: this.attempt },
        { kind: 'set', fields: { checkpoint: parsed.data } },
      ),
    );
    if (!row) throw this.fenced('saveCheckpoint');
  }

  /**
   * Records `waits_for` edges to `taskIds`, which the attempt then names in a `wait` result. One
   * transaction in the lock order: the investigation FOR NO KEY UPDATE first — it serialises the
   * cycle check with every other edge write (spike A2) — then the own task, fenced by the attempt.
   * A refusal (`unknown_dependency`, `self_dependency`, `wait_cycle` with the cycle) writes nothing.
   */
  async registerWait(taskIds: readonly string[]): Promise<RegisterWaitResult> {
    const result = await this.deps.db.transaction(async (tx) => {
      await this.deps.tasks.lockInvestigation(tx, this.investigationId);
      const [own] = await this.deps.tasks.lockTasks(tx, [this.taskId]);
      if (own?.status !== running || own.attempt !== this.attempt) {
        return { outcome: 'fenced' as const };
      }
      return this.deps.scheduler.addWaitEdges(tx, {
        investigationId: this.investigationId,
        taskId: this.taskId,
        targetIds: taskIds,
      });
    });
    if (result.outcome === 'fenced') throw this.fenced('registerWait');
    return result;
  }

  private async appendEvidenceStored(
    tx: RuntimeTx,
    ref: EvidenceRef,
  ): Promise<void> {
    const [task] = await tx
      .select({ stateVersion: researchTasks.stateVersion })
      .from(researchTasks)
      .where(eq(researchTasks.taskId, this.taskId));
    await this.deps.events.append(tx, {
      type: EvidenceStored,
      investigationId: this.investigationId,
      taskId: this.taskId,
      causationId: await this.deps.events.causeOf(tx, {
        type: EvidenceStored,
        taskId: this.taskId,
      }),
      stateRevision: task.stateVersion,
      payloadRef: `evidence:${ref.evidenceId}`,
      payload: {
        evidenceId: ref.evidenceId,
        sha256: ref.sha256,
        byteSize: ref.byteSize,
      },
    });
  }

  /** Why the guarded reservation matched no row; read in the reservation's transaction. */
  private async denyReason(
    tx: RuntimeTx,
    retry: boolean,
  ): Promise<ToolCallDenyReason> {
    const row = await this.deps.tasks.findTask(tx, this.taskId);
    if (row?.status !== running || row.attempt !== this.attempt) {
      this.warnFenced('reserveToolCall');
      return 'not_current_attempt';
    }
    if (row.cancelRequestedAt !== null) return 'cancel_requested';
    if (row.toolCallsUsed + row.attemptToolCalls >= row.maxToolCalls) {
      return 'tool_calls_exhausted';
    }
    return retry ? 'retries_exhausted' : 'tool_calls_exhausted';
  }

  /** A foreign key violation of the evidence insert: the task row was deleted meanwhile. */
  private async fencedOnMissingTask<T>(
    write: () => Promise<T>,
  ): Promise<T | { status: 'fenced' }> {
    try {
      return await write();
    } catch (error) {
      if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) {
        return { status: 'fenced' };
      }
      throw error;
    }
  }

  private fenced(operation: string): AttemptFencedError {
    this.warnFenced(operation);
    return new AttemptFencedError(
      `${operation} of task ${this.taskId} attempt ${this.attempt} is fenced`,
    );
  }

  private warnFenced(operation: string): void {
    this.deps.logger.warn(
      `fenced ${operation} investigationId=${this.investigationId} taskId=${this.taskId} attempt=${this.attempt}`,
    );
  }
}
