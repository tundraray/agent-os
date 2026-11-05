import type {
  EvidenceInput,
  EvidenceRef,
  ExpectedOutput,
  HandlerResultSchema,
  InputRef,
  ProposeResult,
  TaskBudget,
  TaskEdgeKind,
  TaskSpec,
  TaskStatus,
  ToolCallGrant,
} from '@agent-os/contracts';
import type { z } from 'zod';
import type { RuntimeTx } from './guarded-transition.js';

/** A dependency or awaited task of the attempt, with its outputs. */
export interface UpstreamTask {
  taskId: string;
  kind: TaskEdgeKind;
  status: TaskStatus;
  /** `evidenceId`s; empty until `succeeded`. */
  outputRefs: string[];
}

/** Result of `TaskContext.registerWait`: the edges are recorded, or refused without a write. */
export type RegisterWaitResult =
  { outcome: 'ok' } | Extract<ProposeResult, { outcome: 'rejected' }>;

/**
 * Result of `TaskContext.withAttemptGuard`: `work` ran and its transaction committed, or the attempt
 * is not the task's current one (or the task row is gone) and nothing was written.
 */
export type AttemptGuardResult<T> =
  | { outcome: 'committed'; value: T }
  | { outcome: 'fenced' };

/**
 * Fenced API of one attempt (design-runtime.md, TaskHandler и TaskContext). `attempt` is the
 * fencing token: every write of a lost attempt is refused.
 */
export interface TaskContext {
  readonly taskId: string;
  readonly investigationId: string;
  readonly attempt: number;
  readonly input: TaskSpec['input'];
  readonly inputRefs: readonly InputRef[];
  readonly expectedOutput: ExpectedOutput;
  readonly budget: TaskBudget;
  readonly upstream: readonly UpstreamTask[];
  /** The last saved checkpoint, or `null`. */
  readonly checkpoint: unknown;
  /** Aborted with `{ kind: AbortReasonKind }` as `signal.reason`. */
  readonly signal: AbortSignal;
  /** Absolute deadline, fixed at the first start. */
  readonly deadlineAt: Date;
  reserveToolCall(toolName: string, retry: boolean): Promise<ToolCallGrant>;
  putEvidence(evidence: EvidenceInput): Promise<EvidenceRef>;
  /** JSON up to 64 KiB. */
  saveCheckpoint(checkpoint: unknown): Promise<void>;
  registerWait(taskIds: readonly string[]): Promise<RegisterWaitResult>;
  /**
   * Runs `work` — the client's writes to its own tables, nothing else (no model or external call) —
   * in one transaction that first checks, under the task row lock, that the task is `running` with
   * this attempt (KD-9). The transaction is bounded by `RUNTIME_LEASE_MS`. An exception of `work`,
   * a timeout or a failed commit rolls back and is thrown; another `TaskContext` function called
   * inside `work` is refused with an exception at once. `cancel_requested_at` does not change the
   * verdict.
   */
  withAttemptGuard<T>(
    work: (tx: RuntimeTx) => Promise<T>,
  ): Promise<AttemptGuardResult<T>>;
}

/**
 * Result of `TaskHandler.run`. `failed` carries `failure`; `wait` carries `waitFor` (edges
 * already registered through `registerWait`). The dispatcher validates it with
 * `HandlerResultSchema`, which stays in `@agent-os/contracts`.
 */
export type HandlerResult = z.infer<typeof HandlerResultSchema>;

/**
 * Handler port of one workflow type and version; implementations live in `mcp-source` and
 * later features. `inputSchema` checks `TaskSpec.input` at admission.
 */
export interface TaskHandler {
  readonly workflowType: string;
  readonly workflowVersion: number;
  readonly inputSchema: z.ZodType;
  /** An exception fails the task with class `internal`. */
  run(ctx: TaskContext): Promise<HandlerResult>;
}

const handlerKey = (workflowType: string, workflowVersion: number): string =>
  `${workflowType}@${workflowVersion}`;

/**
 * Handlers of this process, registered before `Runtime.start()`. Admission accepts and
 * the dispatcher claims only the types and versions registered here.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  /** Throws on a second handler of the same type and version, which stops the start. */
  register(handler: TaskHandler): void {
    const key = handlerKey(handler.workflowType, handler.workflowVersion);
    if (this.handlers.has(key)) {
      throw new Error(
        `Handler of workflow "${handler.workflowType}" version ${handler.workflowVersion} is already registered`,
      );
    }
    this.handlers.set(key, handler);
  }

  get(workflowType: string, workflowVersion: number): TaskHandler | undefined {
    return this.handlers.get(handlerKey(workflowType, workflowVersion));
  }
}
