import type { Clock, RuntimeTx, TaskContext } from '@agent-os/runtime';
import type { AgentDefinition } from '../config/agent-config.schema.js';
import type { ModelCatalog } from '../config/model-catalog.js';
import { ENGINE_FAILURE_CLASSES } from '../engine-errors.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type { AgentTranscriptInput, TranscriptClosing } from '../transcripts/transcript-writes.js';
import { type CallUsage, callCostUsd, chargedTokens } from './cost.js';
import {
  type CallLedger,
  postgresCallLedger,
  type ReservationClosing,
  type ReservationOutcome,
  type ReservationRequest,
} from './ledger.js';
import { classifyRejection, PROVIDER_RETRIES, providerRetryDelayMs } from './retry-policy.js';
import {
  type AgentToolCall,
  type AgentToolChoice,
  type AgentToolDefinition,
  type AgentTurnCall,
  type AgentTurnGeneration,
  type AgentTurnMessage,
  type AgentTurnModelClient,
  countedTurnTools,
  mastraAgentTurnClient,
  type ReportedUsage,
} from './role-agent.js';
import type { AgentTurnCountRequest, TokenCounter } from './token-counter.js';

/** One turn of an agent run (design-agent-core.md, KD-1): one request with the definition tools, none of them run. */
export interface AgentTurnRequest {
  readonly ctx: TaskContext;
  readonly agentName: string;
  readonly definition: Pick<AgentDefinition, 'model' | 'effort'> &
    Pick<AgentDefinition['limits'], 'maxOutputTokens' | 'marginTokens'>;
  /** Fingerprint of the definition's prompt template. */
  readonly promptVersion: string;
  /** The system block of the session view. */
  readonly instructions: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolDefinition[];
  readonly toolChoice: AgentToolChoice;
  /**
   * `windowTokens − marginTokens` of the definition (DC-30): the gateway counts the turn's input before the reserve, and
   * a counted input over it gets no reserve, no ledger row and no model call.
   */
  readonly inputLimitTokens: number;
  /** What the turn's transcript records as its input: the instructions and the reference to the view. */
  readonly transcriptInput: AgentTranscriptInput;
  /** No turn starts at or after it, and a running request is interrupted at it. */
  readonly notAfter: Date;
  /** How long the reserve waits for other calls' reserves before the turn gives the slot up (`AGENT_BUSY_WAIT_MS`). */
  readonly busyWaitMs: number;
  /**
   * Writes the answer into the session. `ModelGateway` calls it in the guarded transaction that closes the turn's
   * ledger row, so the answer and its row are written together or not at all.
   */
  readonly writeAnswer: (tx: RuntimeTx, answer: AgentTurnAnswer) => Promise<void>;
}

/** The answer of a turn: its ledger row, text and the tool calls the engine is to run. */
export interface AgentTurnAnswer {
  readonly callId: string;
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
}

/** The ceiling refusal of an agent run is `run_tokens_exhausted` (design-agent-core.md, Error Handling). */
type AgentTurnFailureCode = 'run_tokens_exhausted' | 'investigation_tokens_exhausted' | 'model_unavailable';

/**
 * Outcome of an agent turn. `no_answer` with `busy_wait_exhausted` — other calls' reserves kept the turn out longer
 * than `busyWaitMs`: no ledger row and no model call, the run yields its slot (KD-6). `no_answer` with
 * `window_exceeded` — the counted input is over `inputLimitTokens`: no reserve, no ledger row and no model call, and the
 * handler builds the view at the next stage of the window rule (DC-30).
 */
export type AgentTurnResult =
  | { readonly outcome: 'answered'; readonly answer: AgentTurnAnswer }
  | { readonly outcome: 'no_answer'; readonly reason: 'cancelled' | 'deadline' | 'busy_wait_exhausted' }
  | { readonly outcome: 'no_answer'; readonly reason: 'window_exceeded'; readonly countedInputTokens: number }
  | {
      readonly outcome: 'failed';
      readonly code: AgentTurnFailureCode;
      readonly failureClass: (typeof ENGINE_FAILURE_CLASSES)[AgentTurnFailureCode];
    }
  | { readonly outcome: 'fenced' };

export interface ModelGatewayDeps {
  /** Role model instances by catalog id, resolved by `createEngine` through `resolveModel`. */
  readonly models: ReadonlyMap<string, RoleModel>;
  readonly tokenCounter: TokenCounter;
  readonly catalog: ModelCatalog;
  readonly clock: Clock;
  readonly logger: EngineLogger;
  /** Boundary doubles in unit tests; by default the Postgres ledger and the Mastra agent turn client. */
  readonly ledger?: CallLedger;
  readonly turnClient?: AgentTurnModelClient;
}

/** The single path to the model (design-engine.md, C3). */
export interface ModelGateway {
  turn(request: AgentTurnRequest): Promise<AgentTurnResult>;
}

/** Wait between two reserves of a call that other calls' open reserves keep out (design-engine.md, Runtime settings). */
const RESERVE_WAIT_MS = 2_000;

/** A reserve that got past `busy`, or the wait for it ended by a cancel or `notAfter`. */
type ReserveAfterWait =
  | Exclude<ReservationOutcome, { readonly outcome: 'busy' }>
  | { readonly outcome: 'stopped'; readonly reason: 'cancelled' | 'deadline' };

/** A reserve wait with a limit may also end because the limit passed. */
type ReserveWithinLimit = ReserveAfterWait | { readonly outcome: 'busy_wait_exhausted' };

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const ledger = deps.ledger ?? postgresCallLedger;
  const turnClient = deps.turnClient ?? mastraAgentTurnClient;

  /** The model instance `createEngine` resolved for a catalog id; a missing one is a defect of the assembly. */
  const resolvedModel = (modelId: string): RoleModel => {
    const model = deps.models.get(modelId);
    if (model === undefined) throw new Error(`model ${modelId} was not resolved`);
    return model;
  };

  const stopReason = (
    ctx: TaskContext,
    notAfter: Date,
  ): 'cancelled' | 'deadline' | null => {
    if (ctx.signal.aborted) return 'cancelled';
    return deps.clock.now() >= notAfter ? 'deadline' : null;
  };

  /** Waits through the clock; a cancel ends the wait early, and the next check stops the call. */
  const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        cancelTimer();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const cancelTimer = deps.clock.setTimer(ms, done);
      signal.addEventListener('abort', done, { once: true });
    });

  const logFailure = (
    request: AgentTurnRequest,
    attempt: number,
    outcome: string,
    statusCode: number | null,
    errorClass?: string,
  ): void => {
    deps.logger.warn('model call failed', {
      role: 'agent',
      model: request.definition.model,
      statusCode,
      errorClass,
      attempt,
      outcome,
    });
  };

  /**
   * Closes the call's reservation. A reservation a DC-9 close point already charged in full as `abandoned` (the answer
   * was written while this call ran) stays as it is: the call goes on, and one warning without the prompt says so.
   */
  const closeReservation = async (
    request: AgentTurnRequest,
    attempt: number,
    closing: ReservationClosing,
  ): Promise<'closed' | 'fenced'> => {
    const closed = await ledger.close(request.ctx, closing);
    if (closed !== 'already_abandoned') return closed;
    deps.logger.warn('model call closed after its reservation was abandoned', {
      role: 'agent',
      model: request.definition.model,
      investigationId: request.ctx.investigationId,
      taskId: request.ctx.taskId,
      attempt,
      outcome: `${closing.status}_after_abandoned`,
    });
    return 'closed';
  };

  /**
   * Reserves the turn; on `busy` waits 2 seconds on the clock and asks again with the same request — the input is not
   * counted again (DC-5) — up to `limitMs` (KD-6). The wait writes nothing and ends with any other answer of the ledger
   * (`stopping` among them), a cancel or `notAfter`.
   */
  const reserveWithin = async (
    request: Pick<AgentTurnRequest, 'ctx' | 'notAfter'>,
    reservation: ReservationRequest,
    limitMs: number,
  ): Promise<ReserveWithinLimit> => {
    for (let waitedMs = 0; ; waitedMs += RESERVE_WAIT_MS) {
      const reserved = await ledger.reserve(request.ctx, reservation);
      if (reserved.outcome !== 'busy') return reserved;
      if (waitedMs >= limitMs) return { outcome: 'busy_wait_exhausted' };
      await delay(RESERVE_WAIT_MS, request.ctx.signal);
      const stop = stopReason(request.ctx, request.notAfter);
      if (stop !== null) return { outcome: 'stopped', reason: stop };
    }
  };

  const settledClosing = (
    model: string,
    callId: string,
    spend: {
      readonly reported: ReportedUsage;
      readonly reservedTokens: number;
      readonly transcript: TranscriptClosing;
    },
  ): ReservationClosing => {
    const entry = deps.catalog[model];
    if (entry === undefined) {
      throw new Error(`${model} is not in the model catalog`);
    }
    const usage = completeUsage(spend.reported);
    return {
      callId,
      status: 'settled',
      usage,
      // No usage reported: charge the whole reservation — the ledger may overstate, never understate.
      chargedTokens: usage === null ? spend.reservedTokens : chargedTokens(usage),
      costUsd: usage === null ? 0 : callCostUsd(entry, usage),
      transcript: spend.transcript,
    };
  };

  type TurnGenerated =
    | { readonly kind: 'answer'; readonly generation: AgentTurnGeneration }
    | { readonly kind: 'stopped'; readonly reason: 'cancelled' | 'deadline' }
    | { readonly kind: 'provider_error'; readonly retryable: boolean };

  /** The turn request under a signal that a cancel or `notAfter` aborts; a late answer is dropped. */
  const generateTurn = async (request: AgentTurnRequest, attempt: number): Promise<TurnGenerated> => {
    const { ctx } = request;
    const model = resolvedModel(request.definition.model);
    const deadline = new AbortController();
    const cancelDeadline = deps.clock.setTimer(
      Math.max(0, request.notAfter.getTime() - deps.clock.now().getTime()),
      () => deadline.abort(),
    );
    const call: AgentTurnCall = {
      agentName: request.agentName,
      model,
      instructions: request.instructions,
      messages: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      effort: request.definition.effort,
      maxOutputTokens: request.definition.maxOutputTokens,
    };
    try {
      const generation = await turnClient.generateTurn(call, AbortSignal.any([ctx.signal, deadline.signal]));
      const stop = stopAfterCall(ctx, deadline.signal);
      return stop === null ? { kind: 'answer', generation } : { kind: 'stopped', reason: stop };
    } catch (error) {
      const stop = stopAfterCall(ctx, deadline.signal);
      if (stop !== null) return { kind: 'stopped', reason: stop };
      const providerError = classifyRejection(error);
      if (providerError === null) throw error;
      logFailure(request, attempt, 'provider_error', providerError.statusCode);
      return { kind: 'provider_error', retryable: providerError.retryable };
    } finally {
      cancelDeadline();
    }
  };

  type TurnStep = { readonly next: 'done'; readonly result: AgentTurnResult } | { readonly next: 'provider_retry' };

  const turnFailed = (code: AgentTurnFailureCode): AgentTurnResult => ({
    outcome: 'failed',
    code,
    failureClass: ENGINE_FAILURE_CLASSES[code],
  });

  /**
   * One counted, reserved and closed turn request; the answer is written by the close (design-agent-core.md, KD-1). The
   * counted input decides (DC-30): over the limit, the turn ends before any reserve.
   */
  const turnOnce = async (
    request: AgentTurnRequest,
    countRequest: AgentTurnCountRequest,
    attempt: number,
  ): Promise<TurnStep> => {
    const { definition } = request;
    const counted = await deps.tokenCounter.countTurnInputTokens(countRequest, request.ctx.signal);
    const stopAfterCount = stopReason(request.ctx, request.notAfter);
    if (stopAfterCount !== null) {
      return { next: 'done', result: { outcome: 'no_answer', reason: stopAfterCount } };
    }
    if (counted.outcome === 'failed') {
      logFailure(request, attempt, 'token_count_failed', counted.statusCode, counted.errorClass);
      return { next: 'provider_retry' };
    }
    if (counted.inputTokens > request.inputLimitTokens) {
      const exceeded = { outcome: 'no_answer', reason: 'window_exceeded', countedInputTokens: counted.inputTokens } as const;
      return { next: 'done', result: exceeded };
    }
    const reservedTokens = counted.inputTokens + definition.marginTokens + definition.maxOutputTokens;
    const reservation = await reserveWithin(
      request,
      {
        role: 'agent',
        model: definition.model,
        countedInputTokens: counted.inputTokens,
        reservedTokens,
        transcript: { promptVersion: request.promptVersion, input: request.transcriptInput },
      },
      request.busyWaitMs,
    );
    switch (reservation.outcome) {
      case 'busy_wait_exhausted':
        return { next: 'done', result: { outcome: 'no_answer', reason: 'busy_wait_exhausted' } };
      case 'stopped':
        return { next: 'done', result: { outcome: 'no_answer', reason: reservation.reason } };
      case 'fenced':
        return { next: 'done', result: reservation };
      case 'stopping':
        return { next: 'done', result: { outcome: 'no_answer', reason: 'cancelled' } };
      case 'refused':
        // The task's ceiling of an agent run is its share (KD-4).
        return {
          next: 'done',
          result: turnFailed(reservation.code === 'task_tokens_exhausted' ? 'run_tokens_exhausted' : reservation.code),
        };
      case 'reserved':
        break;
    }

    const resolved = await generateTurn(request, attempt);
    if (resolved.kind === 'stopped') {
      return { next: 'done', result: { outcome: 'no_answer', reason: resolved.reason } };
    }
    if (resolved.kind === 'provider_error') {
      const closed = await closeReservation(request, attempt, {
        callId: reservation.callId,
        status: 'failed',
        usage: null,
        chargedTokens: 0,
        costUsd: 0,
        transcript: { outcome: 'provider_error', response: null },
      });
      if (closed === 'fenced') return { next: 'done', result: { outcome: 'fenced' } };
      return resolved.retryable ? { next: 'provider_retry' } : { next: 'done', result: turnFailed('model_unavailable') };
    }

    const { generation } = resolved;
    const answer: AgentTurnAnswer = {
      callId: reservation.callId,
      text: generation.text,
      toolCalls: generation.toolCalls,
    };
    const closing = settledClosing(definition.model, reservation.callId, {
      reported: generation.usage,
      reservedTokens,
      transcript: {
        outcome: 'answered',
        response: {
          object: { toolCalls: generation.toolCalls },
          finishReason: generation.finishReason ?? null,
          ...(generation.text === '' ? {} : { text: generation.text }),
        },
      },
    });
    const closed = await closeReservation(request, attempt, {
      ...closing,
      writeAnswer: (tx) => request.writeAnswer(tx, answer),
    });
    if (closed === 'fenced') return { next: 'done', result: { outcome: 'fenced' } };
    return { next: 'done', result: { outcome: 'answered', answer } };
  };

  return {
    async turn(request) {
      const countRequest: AgentTurnCountRequest = {
        model: request.definition.model,
        system: request.instructions,
        messages: request.messages,
        // The schemas as the turn's request sends them, not as zod writes them: the bytes counted are the bytes sent (DC-30).
        tools: await countedTurnTools(resolvedModel(request.definition.model), request.tools),
        toolChoice: request.toolChoice,
        effort: request.definition.effort,
      };
      let providerRetries = 0;
      for (let attempt = 1; ; attempt += 1) {
        const stop = stopReason(request.ctx, request.notAfter);
        if (stop !== null) return { outcome: 'no_answer', reason: stop };

        const step = await turnOnce(request, countRequest, attempt);
        if (step.next === 'done') return step.result;
        if (providerRetries === PROVIDER_RETRIES) return turnFailed('model_unavailable');
        providerRetries += 1;
        await delay(providerRetryDelayMs(providerRetries), request.ctx.signal);
      }
    },

  };
}

/** A cancel wins over `notAfter`; either one at resolution turns the call into no answer. */
function stopAfterCall(
  ctx: TaskContext,
  deadline: AbortSignal,
): 'cancelled' | 'deadline' | null {
  if (ctx.signal.aborted) return 'cancelled';
  return deadline.aborted ? 'deadline' : null;
}

/** Usage with the input and output the provider reported, or null when it reported neither. */
function completeUsage(reported: ReportedUsage): CallUsage | null {
  if (reported.inputTokens === null || reported.outputTokens === null) return null;
  return {
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    cacheReadTokens: reported.cachedInputTokens ?? 0,
    cacheWriteTokens: reported.cacheCreationInputTokens ?? 0,
  };
}
