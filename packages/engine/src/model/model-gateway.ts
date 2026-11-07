import type { Clock, TaskContext } from '@agent-os/runtime';
import { z } from 'zod';
import type { ModelCatalog } from '../config/model-catalog.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import {
  ENGINE_FAILURE_CLASSES,
  type EngineFailureCode,
  type EngineWarningCode,
} from '../engine-errors.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type {
  TranscriptClosing,
  TranscriptOpening,
  TranscriptResponse,
} from '../transcripts/transcript-writes.js';
import { type CallUsage, callCostUsd, chargedTokens } from './cost.js';
import {
  type CallLedger,
  type ModelRole,
  postgresCallLedger,
  type ReservationClosing,
  type ReservationOutcome,
  type ReservationRequest,
} from './ledger.js';
import {
  classifyRejection,
  classifyResolution,
  INVALID_OUTPUT_RETRIES,
  PROVIDER_RETRIES,
  providerRetryDelayMs,
  type ResolvedCall,
} from './retry-policy.js';
import {
  mastraRoleModelClient,
  providerMessages,
  type ReportedUsage,
  type RoleGeneration,
  type RoleCall,
  type RoleModelClient,
} from './role-agent.js';
import type {
  RoleMessage,
  TokenCounter,
  TokenCountRequest,
} from './token-counter.js';

type RoleConfig = ProcessConfig['roles']['worker'];

/** One model call of a role, as a handler asks for it. */
export interface ModelCallRequest<T> {
  readonly ctx: TaskContext;
  readonly role: ModelRole;
  readonly roleConfig: Pick<
    RoleConfig,
    'model' | 'effort' | 'maxOutputTokens' | 'marginTokens'
  >;
  /** Fingerprint of the role's prompt template, `promptVersion(roleConfig.prompt)` (design-self-check.md, KD-2). */
  readonly promptVersion: string;
  /** The rendered role prompt. */
  readonly instructions: string;
  readonly messages: readonly RoleMessage[];
  readonly outputSchema: z.ZodType<T>;
  /** No call starts at or after it, and a running call is interrupted at it (invariant 5). */
  readonly notAfter: Date;
  /**
   * Saves the answer to the task checkpoint. `ModelGateway` calls it before it closes the
   * reservation, so every write the answer causes follows the checkpoint (invariant 3).
   */
  readonly checkpointAnswer: (output: T) => Promise<void>;
}

/**
 * Outcome of a model call. `no_answer` — the call did not start or was interrupted by a cancel
 * or `notAfter`; nothing was written for it and its open reservation stays for `abandoned`.
 * `fenced` — the attempt lost the task and must stop without an outcome.
 */
export type ModelCallResult<T> =
  | { readonly outcome: 'answered'; readonly output: T }
  | { readonly outcome: 'no_answer'; readonly reason: 'cancelled' | 'deadline' }
  | {
      readonly outcome: 'failed';
      readonly code: Exclude<EngineFailureCode, 'deadline'>;
      readonly failureClass: (typeof ENGINE_FAILURE_CLASSES)[EngineFailureCode];
    }
  | { readonly outcome: EngineWarningCode }
  | { readonly outcome: 'fenced' };

export interface ModelGatewayDeps {
  /** Role model instances by catalog id, resolved by `createEngine` through `resolveModel`. */
  readonly models: ReadonlyMap<string, RoleModel>;
  readonly tokenCounter: TokenCounter;
  readonly catalog: ModelCatalog;
  readonly clock: Clock;
  readonly logger: EngineLogger;
  /** Boundary doubles in unit tests; by default the Postgres ledger and the Mastra role agent. */
  readonly ledger?: CallLedger;
  readonly client?: RoleModelClient;
}

/** The single path to the model (design-engine.md, C3). */
export interface ModelGateway {
  call<T>(request: ModelCallRequest<T>): Promise<ModelCallResult<T>>;
}

/** Wait between two reserves of a call that other calls' open reserves keep out (design-engine.md, Runtime settings). */
const RESERVE_WAIT_MS = 2_000;

/** A reserve that got past `busy`, or the wait for it ended by a cancel or `notAfter`. */
type ReserveAfterWait =
  | Exclude<ReservationOutcome, { readonly outcome: 'busy' }>
  | { readonly outcome: 'stopped'; readonly reason: 'cancelled' | 'deadline' };

type CallStep<T> =
  | { readonly next: 'done'; readonly result: ModelCallResult<T> }
  | { readonly next: 'provider_retry' }
  | { readonly next: 'output_retry' };

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const ledger = deps.ledger ?? postgresCallLedger;
  const client = deps.client ?? mastraRoleModelClient;

  const failed = <T>(
    code: Exclude<EngineFailureCode, 'deadline'>,
  ): ModelCallResult<T> => ({
    outcome: 'failed',
    code,
    failureClass: ENGINE_FAILURE_CLASSES[code],
  });

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
    request: Pick<ModelCallRequest<unknown>, 'role' | 'roleConfig'>,
    attempt: number,
    outcome: string,
    statusCode: number | null,
    errorClass?: string,
  ): void => {
    deps.logger.warn('model call failed', {
      role: request.role,
      model: request.roleConfig.model,
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
    request: Pick<ModelCallRequest<unknown>, 'ctx' | 'role' | 'roleConfig'>,
    attempt: number,
    closing: ReservationClosing,
  ): Promise<'closed' | 'fenced'> => {
    const closed = await ledger.close(request.ctx, closing);
    if (closed !== 'already_abandoned') return closed;
    deps.logger.warn('model call closed after its reservation was abandoned', {
      role: request.role,
      model: request.roleConfig.model,
      investigationId: request.ctx.investigationId,
      taskId: request.ctx.taskId,
      attempt,
      outcome: `${closing.status}_after_abandoned`,
    });
    return 'closed';
  };

  /**
   * Reserves the call; on `busy` waits 2 seconds on the clock and asks again with the same request — the input is not
   * counted again (DC-5). The wait writes nothing and ends with any other answer of the ledger (`stopping` among them),
   * a cancel or `notAfter`.
   */
  const reserveWhenFree = async (
    request: Pick<ModelCallRequest<unknown>, 'ctx' | 'notAfter'>,
    reservation: ReservationRequest,
  ): Promise<ReserveAfterWait> => {
    for (;;) {
      const reserved = await ledger.reserve(request.ctx, reservation);
      if (reserved.outcome !== 'busy') return reserved;
      await delay(RESERVE_WAIT_MS, request.ctx.signal);
      const stop = stopReason(request.ctx, request.notAfter);
      if (stop !== null) return { outcome: 'stopped', reason: stop };
    }
  };

  /** One counted, reserved and closed call; `next` says whether the loop retries. */
  const callOnce = async <T>(
    request: ModelCallRequest<T>,
    prepared: { readonly countRequest: TokenCountRequest; readonly opening: TranscriptOpening },
    attempt: number,
  ): Promise<CallStep<T>> => {
    const { ctx, roleConfig } = request;
    const counted = await deps.tokenCounter.countInputTokens(
      prepared.countRequest,
      ctx.signal,
    );
    const stopAfterCount = stopReason(ctx, request.notAfter);
    if (stopAfterCount !== null) {
      return { next: 'done', result: { outcome: 'no_answer', reason: stopAfterCount } };
    }
    if (counted.outcome === 'failed') {
      logFailure(request, attempt, 'token_count_failed', counted.statusCode, counted.errorClass);
      return { next: 'provider_retry' };
    }

    const reservedTokens =
      counted.inputTokens + roleConfig.marginTokens + roleConfig.maxOutputTokens;
    const reservation = await reserveWhenFree(request, {
      role: request.role,
      model: roleConfig.model,
      countedInputTokens: counted.inputTokens,
      reservedTokens,
      transcript: prepared.opening,
    });
    if (reservation.outcome === 'stopped') {
      return { next: 'done', result: { outcome: 'no_answer', reason: reservation.reason } };
    }
    if (reservation.outcome === 'fenced') return { next: 'done', result: reservation };
    // Stopped or closed work (design-lifecycle.md, KD-2): no call, as if the cancel had interrupted it.
    if (reservation.outcome === 'stopping') {
      return { next: 'done', result: { outcome: 'no_answer', reason: 'cancelled' } };
    }
    if (reservation.outcome === 'refused') {
      return { next: 'done', result: failed(reservation.code) };
    }

    const resolved = await generate(request, attempt);
    switch (resolved.kind) {
      case 'stopped':
        return { next: 'done', result: { outcome: 'no_answer', reason: resolved.reason } };
      case 'provider_error': {
        const closed = await closeReservation(request, attempt, {
          callId: reservation.callId,
          status: 'failed',
          usage: null,
          chargedTokens: 0,
          costUsd: 0,
          transcript: { outcome: 'provider_error', response: null },
        });
        if (closed === 'fenced') return { next: 'done', result: { outcome: 'fenced' } };
        return resolved.retryable
          ? { next: 'provider_retry' }
          : { next: 'done', result: failed('model_unavailable') };
      }
      case 'answer':
        await request.checkpointAnswer(resolved.output);
        break;
      case 'invalid_output':
      case 'refusal':
        logFailure(request, attempt, resolved.kind, null);
        break;
    }

    const closed = await closeReservation(
      request,
      attempt,
      settledClosing(request.roleConfig.model, reservation.callId, {
        reported: resolved.usage,
        reservedTokens,
        transcript: {
          outcome: resolved.kind === 'answer' ? 'answered' : 'invalid_output',
          response: transcriptResponse(resolved.generation),
        },
      }),
    );
    if (closed === 'fenced') return { next: 'done', result: { outcome: 'fenced' } };
    return resolved.kind === 'answer'
      ? { next: 'done', result: { outcome: 'answered', output: resolved.output } }
      : { next: 'output_retry' };
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

  type Generated<T> =
    | (ResolvedCall<T> & { readonly usage: ReportedUsage; readonly generation: RoleGeneration })
    | { readonly kind: 'stopped'; readonly reason: 'cancelled' | 'deadline' }
    | { readonly kind: 'provider_error'; readonly retryable: boolean };

  /** The agent call under a signal that a cancel or `notAfter` aborts; a late answer is dropped. */
  const generate = async <T>(
    request: ModelCallRequest<T>,
    attempt: number,
  ): Promise<Generated<T>> => {
    const { ctx } = request;
    const model = deps.models.get(request.roleConfig.model);
    if (model === undefined) {
      throw new Error(`model ${request.roleConfig.model} was not resolved`);
    }
    const deadline = new AbortController();
    const cancelDeadline = deps.clock.setTimer(
      Math.max(0, request.notAfter.getTime() - deps.clock.now().getTime()),
      () => deadline.abort(),
    );
    const call: RoleCall<T> = {
      role: request.role,
      model,
      instructions: request.instructions,
      messages: request.messages,
      outputSchema: request.outputSchema,
      effort: request.roleConfig.effort,
      maxOutputTokens: request.roleConfig.maxOutputTokens,
    };
    try {
      const generation = await client.generate(
        call,
        AbortSignal.any([ctx.signal, deadline.signal]),
      );
      // `generate` resolves `aborted` only when this signal aborted (S5), so the signal check covers
      // it, and it also drops an answer that resolved after the cancel or `notAfter`.
      const stop = stopAfterCall(ctx, deadline.signal);
      if (stop !== null) return { kind: 'stopped', reason: stop };
      return {
        ...classifyResolution(generation, request.outputSchema),
        usage: generation.usage,
        generation,
      };
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

  return {
    async call<T>(request: ModelCallRequest<T>): Promise<ModelCallResult<T>> {
      const countRequest: TokenCountRequest = {
        model: request.roleConfig.model,
        system: request.instructions,
        messages: request.messages,
        effort: request.roleConfig.effort,
        outputSchema: z.toJSONSchema(request.outputSchema),
      };
      const opening: TranscriptOpening = {
        promptVersion: request.promptVersion,
        input: {
          instructions: request.instructions,
          messages: providerMessages(request.messages),
        },
      };
      let providerRetries = 0;
      let outputRetries = 0;
      for (let attempt = 1; ; attempt += 1) {
        const stop = stopReason(request.ctx, request.notAfter);
        if (stop !== null) return { outcome: 'no_answer', reason: stop };

        const step = await callOnce(request, { countRequest, opening }, attempt);
        if (step.next === 'done') return step.result;
        if (step.next === 'output_retry') {
          if (outputRetries === INVALID_OUTPUT_RETRIES) {
            return { outcome: 'invalid_model_output' };
          }
          outputRetries += 1;
          continue;
        }
        if (providerRetries === PROVIDER_RETRIES) return failed('model_unavailable');
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

/** The answer as the client returned it, before the schema check; the raw text only when it is not empty. */
function transcriptResponse(generation: RoleGeneration): TranscriptResponse {
  return {
    object: generation.object ?? null,
    finishReason: generation.finishReason ?? null,
    ...(generation.text === '' ? {} : { text: generation.text }),
  };
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
