import {
  AbortReasonKindSchema,
  type Coverage,
  type FailureClass,
  type FailureReason,
  type ToolCallDenyReason,
} from '@agent-os/contracts';
import type { Clock, TaskContext } from '@agent-os/runtime';
import { backoffDelayMs, sleepUnlessAborted, type BackoffSettings } from './backoff.js';
import { canonicalJson } from './canonical-json.js';
import type { NormalizedPage, SourceAdapter, SourceToolDescriptor, TransportFailure } from './source-adapter.js';
import type { SourceRegistry } from './source-registry.js';
import type { SourcesSettings } from './sources.settings.js';

/** Max length of `FailureReason.message` (design-runtime.md, FailureReason). */
const FAILURE_MESSAGE_MAX = 2_000;
const PAGE_KEY_DIGITS = 4;
const EVIDENCE_MEDIA_TYPE = 'application/json';
const utf8 = new TextEncoder();

/**
 * Logger port of the sources package (design-mcp-source.md, Logging and Monitoring). Fields carry identifiers,
 * classes, codes and durations only — never arguments, records or the text of `isError`.
 */
export interface SourcesLogger {
  debug(message: string, fields: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields: Readonly<Record<string, unknown>>): void;
  error(message: string, fields: Readonly<Record<string, unknown>>): void;
}

/** One tool call of a task, checked against the allowlist of `workflowType` and the tool's `argsSchema`. */
export interface ToolRequest {
  readonly workflowType: string;
  readonly sourceId: string;
  readonly toolName: string;
  /** Arguments without the cursor. */
  readonly args: Readonly<Record<string, unknown>>;
}

/** Why the attempt stopped without an outcome of its own; the runtime decides what is written. */
export type StopReason = 'fenced' | 'not_current_attempt' | 'shutdown' | 'lease_lost';

/** Result of `ToolExecutor.execute` in the fields of `HandlerResult`; `stopped` ends the attempt without a write. */
export type ToolOutcome =
  | {
      readonly kind: 'completed';
      readonly evidenceRefs: readonly string[];
      readonly coverage: Coverage;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'failed';
      readonly evidenceRefs: readonly string[];
      readonly coverage: Coverage | null;
      readonly failure: FailureReason;
      readonly warnings: readonly string[];
    }
  | { readonly kind: 'stopped'; readonly reason: StopReason };

export interface ToolExecutorDeps {
  readonly registry: SourceRegistry;
  readonly settings: Pick<SourcesSettings, 'callTimeoutMs'> & BackoffSettings;
  readonly clock: Clock;
  readonly logger: SourcesLogger;
}

type FailureDraft = Pick<FailureReason, 'class' | 'code' | 'message' | 'cause'>;

/** The end of a call sequence: a page to store, or the task's outcome without one. */
type PageResult = { readonly kind: 'page'; readonly page: NormalizedPage } | { readonly kind: 'ended'; readonly ended: Ended };
type Ended = { readonly kind: 'failed'; readonly draft: FailureDraft } | { readonly kind: 'stopped'; readonly reason: StopReason };

interface ResolvedCall {
  readonly ctx: TaskContext;
  readonly request: ToolRequest;
  readonly adapter: SourceAdapter;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Counters of this execution, reported in `FailureReason`. */
interface CallCounters {
  toolCalls: number;
  retries: number;
}

/** Rows K-3, K-9 and K-13: a mismatch an operator has to fix, logged at `error`. */
const OPERATOR_ROWS: ReadonlySet<string> = new Set(['K-3', 'K-9', 'K-13']);

function failure(failureClass: FailureClass, code: string, message: string, cause: string | null = null): FailureDraft {
  return { class: failureClass, code, message: message.slice(0, FAILURE_MESSAGE_MAX), cause };
}

const DEADLINE_EXCEEDED = failure('deadline', 'deadline_exceeded', 'The task ran past its deadline during a source call');
const CANCEL_REQUESTED = failure('cancelled', 'cancel_requested', 'The investigation was cancelled');

function pageKey(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(PAGE_KEY_DIGITS, '0')}`;
}

/**
 * Coverage of one page (design-mcp-source.md, Evidence страницы и Пагинация и охват): `truncated` and
 * `continuation` follow `nextCursor`; the page is complete only with no cursor and a confirmed count.
 */
function pageCoverage(page: NormalizedPage): Coverage {
  const confirmed = page.exhausted || (page.totalRelation === 'eq' && page.returned === page.totalMatched);
  return {
    completeness: page.nextCursor === null && confirmed ? 'complete' : 'partial',
    totalMatched: page.totalMatched,
    totalRelation: page.totalRelation,
    returned: page.returned,
    truncated: page.nextCursor !== null,
    continuation: page.nextCursor,
  };
}

function transportFailure(outcome: TransportFailure, message: string): FailureDraft {
  return failure(outcome.failureClass, outcome.code, message, outcome.cause);
}

/**
 * Executes a source tool call for a task (design-mcp-source.md, ToolExecutor.execute): allowlist and `argsSchema`
 * before any reservation; one reservation per source call, a retry only for a retryable K-n row after
 * `reserveToolCall(retry: true)`, with full-jitter backoff on the `Clock` port; the call timeout is capped by the
 * rest of the deadline. The signal is checked before each reservation and call and before a failure is classified,
 * so a deadline or cancel is never reported as a source failure. The page is stored as evidence `page-0001`.
 * Source failures are values; a defect (and K-14) is an exception. No transaction is held across a call.
 */
export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  async execute(ctx: TaskContext, request: ToolRequest): Promise<ToolOutcome> {
    const counters: CallCounters = { toolCalls: 0, retries: 0 };
    const resolved = this.deps.registry.resolveTool(request);
    if (resolved === null) {
      return this.failed(
        ctx,
        counters,
        failure(
          'allowlist_rejected',
          'tool_not_allowlisted',
          `${request.sourceId}/${request.toolName} is not allowlisted for ${request.workflowType}`,
        ),
      );
    }
    const parsed = resolved.tool.argsSchema.safeParse(request.args);
    if (!parsed.success) {
      return this.failed(
        ctx,
        counters,
        failure('validation_rejected', 'tool_args_invalid', argsIssue(resolved.tool, parsed.error)),
      );
    }
    const call: ResolvedCall = {
      ctx,
      request,
      adapter: resolved.adapter,
      args: parsed.data as Readonly<Record<string, unknown>>,
    };
    const result = await this.fetchPage(call, null, counters);
    if (result.kind === 'ended') {
      return this.endedOutcome(call, result.ended, counters);
    }
    return this.storePage(call, result.page, { pageNumber: 1, cursor: null });
  }

  private async storePage(
    call: ResolvedCall,
    page: NormalizedPage,
    position: { pageNumber: number; cursor: string | null },
  ): Promise<ToolOutcome> {
    const { pageNumber, cursor } = position;
    const coverage = pageCoverage(page);
    const ref = await call.ctx.putEvidence({
      evidenceKey: pageKey(pageNumber),
      provenance: {
        sourceId: call.request.sourceId,
        toolName: call.request.toolName,
        normalizedArgs: JSON.parse(canonicalJson({ ...call.args, cursor })),
        snapshot: page.snapshot,
      },
      coverage,
      content: { mediaType: EVIDENCE_MEDIA_TYPE, bytes: utf8.encode(canonicalJson({ pageNumber, ...page })) },
    });
    return { kind: 'completed', evidenceRefs: [ref.evidenceId], coverage, warnings: [] };
  }

  /**
   * Reserves and calls until a page or a final outcome. Each retry takes its own reservation with `retry: true`;
   * the runtime counts both limits (KD-7).
   */
  private async fetchPage(call: ResolvedCall, cursor: string | null, counters: CallCounters): Promise<PageResult> {
    const { ctx, request } = call;
    let lastFailure: TransportFailure | null = null;
    for (let retryIndex = 0; ; retryIndex += 1) {
      const retry = lastFailure !== null;
      const beforeReserve = this.abortedOutcome(ctx);
      if (beforeReserve !== null) return ended(beforeReserve);
      const grant = await ctx.reserveToolCall(request.toolName, retry);
      if (!grant.granted) return ended(denialOutcome(grant.reason, lastFailure));
      counters.toolCalls += 1;
      if (lastFailure !== null) {
        counters.retries += 1;
        this.logRetry(call, grant.callIndex, lastFailure);
      }

      const beforeCall = this.abortedOutcome(ctx);
      if (beforeCall !== null) return ended(beforeCall);
      const remainingMs = this.remainingMs(ctx);
      if (remainingMs <= 0) return ended({ kind: 'failed', draft: DEADLINE_EXCEEDED });
      const timeoutMs = Math.min(this.deps.settings.callTimeoutMs, remainingMs);
      const outcome = await call.adapter.call({
        toolName: request.toolName,
        args: call.args,
        cursor,
        signal: ctx.signal,
        timeoutMs,
      });

      // K-1 before any classification: the client reports an abort as RequestTimeout.
      const afterCall = this.abortedOutcome(ctx);
      if (afterCall !== null) return ended(afterCall);
      if (outcome.kind === 'page') return { kind: 'page', page: outcome.page };
      if (outcome.kind === 'tool_error') {
        return ended({ kind: 'failed', draft: failure('tool_error', 'tool_error', outcome.message, 'K-10') });
      }
      if (outcome.code === 'timeout' && timeoutMs < this.deps.settings.callTimeoutMs) {
        return ended({
          kind: 'failed',
          draft: failure('deadline', 'deadline_in_call', 'The call timeout capped by the deadline fired', 'K-2'),
        });
      }
      if (!outcome.retryable) {
        this.logFailure(call, grant.callIndex, outcome);
        return ended({ kind: 'failed', draft: transportFailure(outcome, `Source call failed (${outcome.cause})`) });
      }

      lastFailure = outcome;
      const delayMs = backoffDelayMs(retryIndex, this.deps.settings, () => this.deps.clock.random());
      if (delayMs >= this.remainingMs(ctx)) {
        return ended({
          kind: 'failed',
          draft: failure('deadline', 'deadline_before_retry', 'The next retry would start after the deadline', outcome.cause),
        });
      }
      await sleepUnlessAborted(delayMs, this.deps.clock, ctx.signal);
    }
  }

  /** K-1: the outcome named by `signal.reason.kind`, or null while the signal is quiet. */
  private abortedOutcome(ctx: TaskContext): Ended | null {
    if (!ctx.signal.aborted) {
      return null;
    }
    const reason: unknown = ctx.signal.reason;
    const kind = AbortReasonKindSchema.parse((reason as { kind?: unknown } | undefined)?.kind);
    switch (kind) {
      case 'deadline':
        return { kind: 'failed', draft: DEADLINE_EXCEEDED };
      case 'cancelled':
        return { kind: 'failed', draft: CANCEL_REQUESTED };
      case 'shutdown':
      case 'lease_lost':
        return { kind: 'stopped', reason: kind };
    }
  }

  private remainingMs(ctx: TaskContext): number {
    return ctx.deadlineAt.getTime() - this.deps.clock.now().getTime();
  }

  private endedOutcome(call: ResolvedCall, outcome: Ended, counters: CallCounters): ToolOutcome {
    if (outcome.kind === 'stopped') {
      this.deps.logger.warn('source call stopped', { ...this.fields(call, null), reason: outcome.reason });
      return outcome;
    }
    return this.failed(call.ctx, counters, outcome.draft);
  }

  private failed(ctx: TaskContext, counters: CallCounters, draft: FailureDraft): ToolOutcome {
    return {
      kind: 'failed',
      evidenceRefs: [],
      coverage: null,
      failure: { ...draft, attempt: ctx.attempt, toolCalls: counters.toolCalls, retries: counters.retries },
      warnings: [],
    };
  }

  /** A granted retry; after K-5 the call goes to a restarted process. */
  private logRetry(call: ResolvedCall, callIndex: number, retried: TransportFailure): void {
    this.deps.logger.warn(retried.reconnect ? 'source call retry after process restart' : 'source call retry', {
      ...this.fields(call, callIndex),
      class: retried.failureClass,
      code: retried.code,
      cause: retried.cause,
    });
  }

  private logFailure(call: ResolvedCall, callIndex: number, outcome: TransportFailure): void {
    if (OPERATOR_ROWS.has(outcome.cause)) {
      this.deps.logger.error('source call failed: configuration or protocol mismatch', {
        ...this.fields(call, callIndex),
        class: outcome.failureClass,
        code: outcome.code,
        cause: outcome.cause,
      });
    }
  }

  private fields(call: ResolvedCall, callIndex: number | null): Record<string, unknown> {
    return {
      taskId: call.ctx.taskId,
      attempt: call.ctx.attempt,
      sourceId: call.request.sourceId,
      toolName: call.request.toolName,
      callIndex,
    };
  }
}

function ended(outcome: Ended): PageResult {
  return { kind: 'ended', ended: outcome };
}

/**
 * A refused reservation (design-mcp-source.md, Error Handling): before the first call the call limit is
 * `budget_exhausted`; on a retry either limit ends the task with the class of the last failure.
 */
function denialOutcome(reason: ToolCallDenyReason, lastFailure: TransportFailure | null): Ended {
  switch (reason) {
    case 'not_current_attempt':
      return { kind: 'stopped', reason };
    case 'cancel_requested':
      return { kind: 'failed', draft: CANCEL_REQUESTED };
    case 'tool_calls_exhausted':
    case 'retries_exhausted':
      if (lastFailure !== null) {
        return {
          kind: 'failed',
          draft: transportFailure(lastFailure, `Source call failed and no retry is left: ${reason} (${lastFailure.cause})`),
        };
      }
      if (reason === 'tool_calls_exhausted') {
        return { kind: 'failed', draft: failure('budget_exhausted', 'tool_calls_exhausted', 'The task has no tool calls left') };
      }
      throw new Error('retries_exhausted refused a first call, which never asks for a retry');
  }
}

/** Where the arguments break the schema, without their values (they may carry user data). */
function argsIssue(tool: SourceToolDescriptor, error: unknown): string {
  const issues = (error as { issues?: { path?: PropertyKey[] }[] } | null)?.issues ?? [];
  const paths = issues.map((issue) => (issue.path ?? []).map(String).join('.') || '(root)');
  return `Arguments of ${tool.name} break its schema at ${paths.join(', ') || '(unknown)'}`;
}
