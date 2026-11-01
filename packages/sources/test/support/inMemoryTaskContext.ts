import { createHash, randomUUID } from 'node:crypto';
import {
  EvidenceInputSchema,
  type AbortReasonKind,
  type EvidenceInput,
  type EvidenceRef,
  type ExpectedOutput,
  type InputRef,
  type TaskBudget,
  type TaskSpec,
  type ToolCallDenyReason,
  type ToolCallGrant,
} from '@agent-os/contracts';
import type { RegisterWaitResult, TaskContext } from '@agent-os/runtime';

/** One `reserveToolCall` as the attempt asked for it, and the answer. */
export interface ReservationRecord {
  readonly toolName: string;
  readonly retry: boolean;
  readonly grant: ToolCallGrant;
}

export interface StoredEvidenceRecord {
  readonly input: EvidenceInput;
  readonly ref: EvidenceRef;
}

export interface InMemoryTaskContextOptions {
  readonly maxRetries: number;
  readonly maxToolCalls: number;
  /** Milliseconds from now to `deadlineAt`; the context never aborts by itself at the deadline. */
  readonly deadlineInMs?: number;
  /**
   * A refusal the runtime would give from the `fromReservation`-th reservation on (1-based), whatever the limits:
   * the attempt lost its lease (`not_current_attempt`) or the investigation was cancelled (`cancel_requested`).
   */
  readonly denyFrom?: {
    readonly reservation: number;
    readonly reason: Extract<ToolCallDenyReason, 'not_current_attempt' | 'cancel_requested'>;
  };
  /** `putEvidence` and `saveCheckpoint` throw as the runtime does for a fenced write. */
  readonly fencedWrites?: boolean;
  /** `TaskSpec.input` and `inputRefs` of the task; empty by default. */
  readonly input?: TaskSpec['input'];
  readonly inputRefs?: readonly InputRef[];
  /** `expectedOutput.completeness`; `sample` by default. */
  readonly completeness?: ExpectedOutput['completeness'];
  /** The checkpoint a previous attempt saved; null by default. */
  readonly checkpoint?: unknown;
}

const DEFAULT_DEADLINE_MS = 60_000;

class FencedWriteError extends Error {
  override readonly name = 'AttemptFencedError';
  readonly reason = 'fenced';
}

/**
 * `TaskContext` of one attempt held in memory (design-mcp-source.md, Test Boundaries): the runtime reservation
 * rule — a call while `toolCallsUsed < maxToolCalls`, a retry also while `retriesUsed < maxRetries`, refusals in
 * the runtime's order — evidence stored by key and checkpoints as JSON. Every reservation is journalled, granted
 * or not. A fenced write throws an error with `reason: 'fenced'`, as the runtime's `TaskContext` does.
 */
export class InMemoryTaskContext implements TaskContext {
  readonly taskId = randomUUID();
  readonly investigationId = randomUUID();
  readonly attempt = 1;
  readonly input: TaskSpec['input'];
  readonly inputRefs: readonly InputRef[];
  readonly expectedOutput: ExpectedOutput;
  readonly budget: TaskBudget;
  readonly upstream = [];
  readonly checkpoint: unknown;
  readonly deadlineAt: Date;
  readonly reservations: ReservationRecord[] = [];
  readonly evidence: StoredEvidenceRecord[] = [];
  /** Every saved checkpoint in order, as the JSON the runtime would store. */
  readonly checkpoints: unknown[] = [];
  private readonly controller = new AbortController();
  private toolCallsUsed = 0;
  private retriesUsed = 0;

  constructor(private readonly options: InMemoryTaskContextOptions) {
    const deadlineMs = options.deadlineInMs ?? DEFAULT_DEADLINE_MS;
    this.input = options.input ?? {};
    this.inputRefs = options.inputRefs ?? [];
    this.expectedOutput = { description: 'integration test task', completeness: options.completeness ?? 'sample' };
    this.checkpoint = options.checkpoint ?? null;
    this.deadlineAt = new Date(Date.now() + deadlineMs);
    this.budget = {
      maxToolCalls: options.maxToolCalls,
      maxRetries: options.maxRetries,
      deadlineMs: Math.max(deadlineMs, 1_000),
      maxTokens: 0,
    };
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Granted reservations: the attempt's `toolCallsUsed`. */
  get toolCalls(): number {
    return this.toolCallsUsed;
  }

  get retries(): number {
    return this.retriesUsed;
  }

  /** Aborts the attempt the way the runtime does: `signal.reason` is `{ kind }`. */
  abort(kind: AbortReasonKind): void {
    this.controller.abort({ kind });
  }

  reserveToolCall(toolName: string, retry: boolean): Promise<ToolCallGrant> {
    const grant = this.decide(retry);
    if (grant.granted) {
      this.toolCallsUsed += 1;
      this.retriesUsed += retry ? 1 : 0;
    }
    this.reservations.push({ toolName, retry, grant });
    return Promise.resolve(grant);
  }

  putEvidence(evidence: EvidenceInput): Promise<EvidenceRef> {
    if (this.options.fencedWrites === true) {
      return Promise.reject(this.fenced('putEvidence'));
    }
    const input = EvidenceInputSchema.parse(evidence);
    const stored = this.evidence.find((record) => record.input.evidenceKey === input.evidenceKey);
    if (stored !== undefined) {
      return Promise.resolve(stored.ref);
    }
    const ref: EvidenceRef = {
      evidenceId: randomUUID(),
      sha256: createHash('sha256').update(input.content.bytes).digest('hex'),
      byteSize: input.content.bytes.byteLength,
    };
    this.evidence.push({ input, ref });
    return Promise.resolve(ref);
  }

  saveCheckpoint(checkpoint: unknown): Promise<void> {
    if (this.options.fencedWrites === true) {
      return Promise.reject(this.fenced('saveCheckpoint'));
    }
    this.checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
    return Promise.resolve();
  }

  registerWait(): Promise<RegisterWaitResult> {
    return Promise.reject(new Error('registerWait is not used by source.fetch'));
  }

  withAttemptGuard(): Promise<never> {
    return Promise.reject(new Error('withAttemptGuard is not used by source.fetch'));
  }

  private fenced(operation: string): FencedWriteError {
    return new FencedWriteError(`${operation} of task ${this.taskId} attempt ${this.attempt} is fenced`);
  }

  /** The runtime's refusal order: not the current attempt, cancel requested, call limit, retry limit. */
  private decide(retry: boolean): ToolCallGrant {
    const { denyFrom } = this.options;
    if (denyFrom !== undefined && this.reservations.length + 1 >= denyFrom.reservation) {
      return { granted: false, reason: denyFrom.reason };
    }
    if (this.toolCallsUsed >= this.options.maxToolCalls) {
      return { granted: false, reason: 'tool_calls_exhausted' };
    }
    if (retry && this.retriesUsed >= this.options.maxRetries) {
      return { granted: false, reason: 'retries_exhausted' };
    }
    return { granted: true, callIndex: this.toolCallsUsed };
  }
}
