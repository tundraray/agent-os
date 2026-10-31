import { createHash, randomUUID } from 'node:crypto';
import {
  EvidenceInputSchema,
  type AbortReasonKind,
  type EvidenceInput,
  type EvidenceRef,
  type TaskBudget,
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
  /** `putEvidence` throws as the runtime does for a fenced write. */
  readonly fencedWrites?: boolean;
}

const DEFAULT_DEADLINE_MS = 60_000;

class FencedWriteError extends Error {
  override readonly name = 'AttemptFencedError';
  readonly reason = 'fenced';
}

/**
 * `TaskContext` of one attempt held in memory (design-mcp-source.md, Test Boundaries): the runtime reservation
 * rule — a call while `toolCallsUsed < maxToolCalls`, a retry also while `retriesUsed < maxRetries`, refusals in
 * the runtime's order — and evidence stored by key. Every reservation is journalled, granted or not.
 */
export class InMemoryTaskContext implements TaskContext {
  readonly taskId = randomUUID();
  readonly investigationId = randomUUID();
  readonly attempt = 1;
  readonly input = {};
  readonly inputRefs = [];
  readonly expectedOutput = { description: 'integration test task', completeness: 'sample' } as const;
  readonly budget: TaskBudget;
  readonly upstream = [];
  readonly checkpoint = null;
  readonly deadlineAt: Date;
  readonly reservations: ReservationRecord[] = [];
  readonly evidence: StoredEvidenceRecord[] = [];
  private readonly controller = new AbortController();
  private toolCallsUsed = 0;
  private retriesUsed = 0;

  constructor(private readonly options: InMemoryTaskContextOptions) {
    const deadlineMs = options.deadlineInMs ?? DEFAULT_DEADLINE_MS;
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
      return Promise.reject(new FencedWriteError(`putEvidence of task ${this.taskId} is fenced`));
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

  saveCheckpoint(): Promise<void> {
    return Promise.resolve();
  }

  registerWait(): Promise<RegisterWaitResult> {
    return Promise.reject(new Error('registerWait is not used by source.fetch'));
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
