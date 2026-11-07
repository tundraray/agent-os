import {
  AbortReasonKindSchema,
  type Coverage,
  type EvidenceInput,
  type ExpectedOutput,
  type FailureClass,
  type FailureReason,
  type ToolCallDenyReason,
} from '@agent-os/contracts';
import type { Clock, TaskContext } from '@agent-os/runtime';
import { backoffDelayMs, sleepUnlessAborted, type BackoffSettings } from './backoff.js';
import { canonicalJson } from './canonical-json.js';
import { coverageOf } from './completeness.js';
import type { FetchCheckpoint } from './fetch-input.js';
import type { NormalizedPage, SourceAdapter, SourceToolDescriptor, TransportFailure } from './source-adapter.js';
import type { SourceRegistry } from './source-registry.js';
import type { SourcesLogger } from './sources-logger.js';
import type { SourcesSettings } from './sources.settings.js';

/** Max length of `FailureReason.message` (design-runtime.md, FailureReason). */
const FAILURE_MESSAGE_MAX = 2_000;
const PAGE_KEY_DIGITS = 4;
const EVIDENCE_MEDIA_TYPE = 'application/json';
const utf8 = new TextEncoder();

/**
 * The tool calls of a task (design-mcp-source.md, FetchInput и ToolRequest), checked against the allowlist of
 * `workflowType` and the tool's `argsSchema`.
 */
export interface ToolRequest {
  readonly workflowType: string;
  readonly sourceId: string;
  readonly toolName: string;
  /** Arguments without the cursor. */
  readonly args: Readonly<Record<string, unknown>>;
  /** The snapshot the task is pinned to; a page of another snapshot is not stored. */
  readonly pin: string;
  /** `all`: pages until the cursor ends; `sample`: one page. */
  readonly completeness: ExpectedOutput['completeness'];
  /** Where a previous attempt stopped, or null. */
  readonly resume: FetchCheckpoint | null;
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
  readonly settings: Pick<SourcesSettings, 'callTimeoutMs' | 'maxPages'> & BackoffSettings;
  readonly clock: Clock;
  readonly logger: SourcesLogger;
}

type FailureDraft = Pick<FailureReason, 'class' | 'code' | 'message' | 'cause'>;

/** The end of a call sequence: a page to store, or the task's outcome without one. */
type PageResult = { readonly kind: 'page'; readonly page: NormalizedPage } | { readonly kind: 'ended'; readonly ended: Ended };
type Ended =
  | { readonly kind: 'failed'; readonly draft: FailureDraft }
  | { readonly kind: 'stopped'; readonly reason: StopReason }
  /** The first reservation of a page was refused for the call limit. */
  | { readonly kind: 'exhausted' };

const FENCED = { kind: 'stopped', reason: 'fenced' } as const satisfies Ended;

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
const TOOL_CALLS_EXHAUSTED = failure('budget_exhausted', 'tool_calls_exhausted', 'The task has no tool calls left');

/** A task that has not stored a page yet. */
const FIRST_PAGE: FetchCheckpoint = {
  nextPage: 1,
  cursor: null,
  unpinnedAt: null,
  evidenceIds: [],
  returned: 0,
  totalMatched: null,
  totalRelation: null,
};

function pageKey(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(PAGE_KEY_DIGITS, '0')}`;
}

/** The position after `page`, stored as `evidenceId`. */
function advance(position: FetchCheckpoint, page: NormalizedPage, evidenceId: string): FetchCheckpoint {
  return {
    nextPage: position.nextPage + 1,
    cursor: page.nextCursor,
    unpinnedAt: position.unpinnedAt,
    evidenceIds: [...position.evidenceIds, evidenceId],
    returned: position.returned + page.returned,
    totalMatched: page.totalMatched,
    totalRelation: page.totalRelation,
  };
}

/** The runtime refuses a write of a lost attempt with an error whose `reason` is `fenced`. */
function isFenced(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'fenced';
}

const FENCED_WRITE = Symbol('fenced write');

/** The write's value, or `FENCED_WRITE` when the runtime refused it; any other error propagates. */
async function unlessFenced<T>(write: () => Promise<T>): Promise<T | typeof FENCED_WRITE> {
  try {
    return await write();
  } catch (error) {
    if (isFenced(error)) return FENCED_WRITE;
    throw error;
  }
}

/** The cursor ended on `page` (or `sample` took one page): coverage of every stored page by the completeness rule. */
function completed(position: FetchCheckpoint, page: NormalizedPage): ToolOutcome {
  const { coverage, warnings } = coverageOf({ ...page, returned: position.returned });
  return { kind: 'completed', evidenceRefs: position.evidenceIds, coverage, warnings };
}

/** The loop stopped with a cursor left (call or page limit after the first page): `partial`, continuing at the cursor. */
function partial(position: FetchCheckpoint): ToolOutcome {
  const { coverage, warnings } = coverageOf({
    returned: position.returned,
    totalMatched: position.totalMatched,
    totalRelation: position.totalRelation,
    nextCursor: position.cursor,
    exhausted: false,
  });
  return { kind: 'completed', evidenceRefs: position.evidenceIds, coverage, warnings };
}

function transportFailure(outcome: TransportFailure, message: string): FailureDraft {
  return failure(outcome.failureClass, outcome.code, message, outcome.cause);
}

/**
 * Executes the source tool calls of a task (design-mcp-source.md, ToolExecutor.execute and Flow 1): allowlist and
 * `argsSchema` before any reservation; one reservation per source call, a retry only for a retryable K-n row after
 * `reserveToolCall(retry: true)`, with full-jitter backoff on the `Clock` port; the call timeout is capped by the
 * rest of the deadline. The signal is checked before each reservation and call and before a failure is classified,
 * so a deadline or cancel is never reported as a source failure.
 *
 * Pages are fetched from `resume` (or the first page) until the cursor ends, a reservation is refused or
 * `SOURCE_MAX_PAGES` is reached (checked before the reservation); `sample` fetches one page. Each page of the pinned
 * snapshot is stored as evidence `page-NNNN`, followed by a checkpoint when the loop goes on; a page of another
 * snapshot ends the task `snapshot_changed` unstored, and the pages before it stay out of `evidenceRefs`. A fenced
 * write or a lost attempt is `stopped` with no further call. Source failures are values; a defect (and K-14) is an
 * exception. No transaction is held across a call.
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
    return this.fetchPages(call, counters);
  }

  private async fetchPages(call: ResolvedCall, counters: CallCounters): Promise<ToolOutcome> {
    let position = call.request.resume ?? FIRST_PAGE;
    for (;;) {
      if (position.nextPage > this.deps.settings.maxPages) {
        this.deps.logger.debug('source fetch reached the page limit', { ...this.fields(call, null), pages: position.evidenceIds.length });
        return partial(position);
      }
      const result = await this.fetchPage(call, position.cursor, counters);
      if (result.kind === 'ended') {
        if (result.ended.kind === 'exhausted' && position.nextPage > 1) return partial(position);
        return this.endedOutcome(call, result.ended, counters);
      }
      const { page } = result;
      if (page.snapshot !== call.request.pin) {
        return this.snapshotChanged(call, counters, page.snapshot);
      }
      const ref = await unlessFenced(() => call.ctx.putEvidence(this.pageEvidence(call, page, position)));
      if (ref === FENCED_WRITE) return this.endedOutcome(call, FENCED, counters);
      const next = advance(position, page, ref.evidenceId);
      if (page.nextCursor === null || call.request.completeness === 'sample') {
        return completed(next, page);
      }
      const saved = await unlessFenced(() => call.ctx.saveCheckpoint(next));
      if (saved === FENCED_WRITE) return this.endedOutcome(call, FENCED, counters);
      position = next;
    }
  }

  /**
   * Evidence of one page (design-mcp-source.md, Evidence страницы): its key and content depend only on the
   * snapshot, the arguments and the page number, so a page fetched again stores nothing new.
   */
  private pageEvidence(call: ResolvedCall, page: NormalizedPage, position: FetchCheckpoint): EvidenceInput {
    const pageNumber = position.nextPage;
    return {
      evidenceKey: pageKey(pageNumber),
      provenance: {
        sourceId: call.request.sourceId,
        toolName: call.request.toolName,
        normalizedArgs: JSON.parse(canonicalJson({ ...call.args, cursor: position.cursor })),
        snapshot: page.snapshot,
      },
      coverage: coverageOf(page).coverage,
      content: { mediaType: EVIDENCE_MEDIA_TYPE, bytes: utf8.encode(canonicalJson({ pageNumber, ...page })) },
    };
  }

  private snapshotChanged(call: ResolvedCall, counters: CallCounters, snapshot: string): ToolOutcome {
    this.deps.logger.warn('source snapshot changed', { ...this.fields(call, null), pinned: call.request.pin, snapshot });
    return this.failed(
      call.ctx,
      counters,
      failure(
        'snapshot_changed',
        'snapshot_changed',
        `A page came from snapshot ${snapshot}, the task is pinned to ${call.request.pin}`,
      ),
    );
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
      // The attempt ran past its limit: as a lost lease, the runtime writes what follows.
      case 'attempt_timeout':
        return { kind: 'stopped', reason: 'lease_lost' };
    }
  }

  private remainingMs(ctx: TaskContext): number {
    return ctx.deadlineAt.getTime() - this.deps.clock.now().getTime();
  }

  private endedOutcome(call: ResolvedCall, outcome: Ended, counters: CallCounters): ToolOutcome {
    switch (outcome.kind) {
      case 'stopped':
        this.deps.logger.warn('source call stopped', { ...this.fields(call, null), reason: outcome.reason });
        return outcome;
      case 'exhausted':
        return this.failed(call.ctx, counters, TOOL_CALLS_EXHAUSTED);
      case 'failed':
        return this.failed(call.ctx, counters, outcome.draft);
    }
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
 * A refused reservation (design-mcp-source.md, Error Handling): the call limit on a page's first call is
 * `exhausted` (`budget_exhausted` on the first page, `partial` after it); on a retry either limit ends the task
 * with the class of the last failure.
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
        return { kind: 'exhausted' };
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
