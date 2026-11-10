import type { Clock } from '@agent-os/runtime';
import type { z } from 'zod';
import type { ModelCatalog } from '../config/model-catalog.js';
import { type CallUsage, callCostUsd } from '../model/cost.js';
import { promptVersion } from '../model/prompt-version.js';
import {
  classifyRejection,
  classifyResolution,
  INVALID_OUTPUT_RETRIES,
  PROVIDER_RETRIES,
  providerRetryDelayMs,
} from '../model/retry-policy.js';
import {
  mastraRoleModelClient,
  providerMessages,
  type ReportedUsage,
  type RoleGeneration,
  type RoleModelClient,
} from '../model/role-agent.js';
import type { RoleEffort, RoleMessage } from '../model/token-counter.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type {
  OutsideTaskTranscripts,
  TranscriptBinding,
  TranscriptClosing,
  TranscriptOpening,
  TranscriptRole,
} from '../transcripts/transcript-writes.js';

export type AssessRole = TranscriptRole;
export type AssessBinding = TranscriptBinding;

/** One model call with a JSON answer outside an investigation task (design-self-check.md, `Engine.assess`). */
export interface AssessRequest<T> {
  /** `judge`, or a process role name, e.g. `verifier` for a calibration call. */
  readonly role: AssessRole;
  /** Catalog id; only the models the assembly point allowed for `assess` are called. */
  readonly model: string;
  readonly effort: RoleEffort;
  readonly maxOutputTokens: number;
  /** The prompt version is the fingerprint of this text as it is, without any edit (KD-2). */
  readonly instructions: string;
  readonly messages: readonly RoleMessage[];
  readonly outputSchema: z.ZodType<T>;
  readonly binding: AssessBinding;
  /** No attempt starts at or after it. */
  readonly notAfter: Date;
}

/** Spend of all attempts of one `assess`; the caller counts it, no investigation budget does. */
export interface AssessUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

export type AssessResult<T> =
  | { readonly outcome: 'answered'; readonly output: T; readonly usage: AssessUsage }
  | { readonly outcome: 'invalid_output'; readonly usage: AssessUsage }
  | { readonly outcome: 'failed'; readonly code: 'model_unavailable'; readonly usage: AssessUsage };

export type Assess = <T>(request: AssessRequest<T>) => Promise<AssessResult<T>>;

export interface AssessDeps {
  /** Instances of the models allowed for `assess`, resolved through `resolveModel` at creation; any other is refused. */
  readonly models: ReadonlyMap<string, RoleModel>;
  readonly catalog: ModelCatalog;
  readonly clock: Clock;
  readonly logger: EngineLogger;
  readonly transcripts: OutsideTaskTranscripts;
  /** Boundary double in unit tests; the Mastra role agent by default. */
  readonly client?: RoleModelClient;
}

/** What one attempt ended with; `next` says whether the loop retries. */
type AttemptStep<T> =
  | { readonly next: 'answered'; readonly output: T }
  | { readonly next: 'output_retry' }
  | { readonly next: 'provider_retry' }
  | { readonly next: 'final_provider_error' };

const NO_USAGE: AssessUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

/**
 * `Engine.assess`: retries by the rules of `ModelGateway` (`retry-policy.ts`) — two after a provider error, one after
 * an answer off the schema or a refusal — and writes a transcript per attempt, without a ledger row or a reservation.
 * A model outside `deps.models` is `model_unavailable` before any write or provider call.
 */
export function createAssess(deps: AssessDeps): Assess {
  const client = deps.client ?? mastraRoleModelClient;
  // `assess` has no cancel of its own: an attempt is never interrupted, only not started after `notAfter`.
  const neverAborted = new AbortController().signal;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      deps.clock.setTimer(ms, resolve);
    });

  const logFailure = (request: AssessRequest<unknown>, attempt: number, outcome: string, statusCode: number | null) => {
    deps.logger.warn('assess call failed', {
      role: request.role,
      model: request.model,
      ...(request.binding.investigationId === undefined ? {} : { investigationId: request.binding.investigationId }),
      statusCode,
      attempt,
      outcome,
    });
  };

  const priced = (model: string, reported: ReportedUsage): { usage: CallUsage | null; costUsd: number } => {
    const entry = deps.catalog[model];
    if (entry === undefined) throw new Error(`${model} is not in the model catalog`);
    const usage = completeUsage(reported);
    return { usage, costUsd: usage === null ? 0 : callCostUsd(entry, usage) };
  };

  return async <T>(request: AssessRequest<T>): Promise<AssessResult<T>> => {
    if (!isBound(request.binding)) {
      throw new Error('assess needs an investigationId or a selfCheckRunId to bind its transcripts to');
    }
    const model = deps.models.get(request.model);
    if (model === undefined) {
      deps.logger.warn('assess model is not allowed', { role: request.role, model: request.model, outcome: 'model_unavailable' });
      return { outcome: 'failed', code: 'model_unavailable', usage: NO_USAGE };
    }
    const opening: TranscriptOpening = {
      promptVersion: promptVersion(request.instructions),
      input: { instructions: request.instructions, messages: providerMessages(request.messages) },
    };
    let spent = NO_USAGE;
    const record = (closing: { usage: CallUsage | null; costUsd: number }) => {
      spent = addUsage(spent, closing);
    };

    const attemptOnce = async (attempt: number): Promise<AttemptStep<T>> => {
      const callId = await deps.transcripts.open({
        role: request.role,
        model: request.model,
        binding: request.binding,
        opening,
      });
      let generation: RoleGeneration;
      try {
        generation = await client.generate(
          {
            role: request.role,
            model,
            instructions: request.instructions,
            messages: request.messages,
            outputSchema: request.outputSchema,
            effort: request.effort,
            maxOutputTokens: request.maxOutputTokens,
          },
          neverAborted,
        );
      } catch (error) {
        const providerError = classifyRejection(error);
        if (providerError === null) throw error;
        logFailure(request, attempt, 'provider_error', providerError.statusCode);
        await deps.transcripts.close(callId, {
          transcript: { outcome: 'provider_error', response: null },
          usage: null,
          costUsd: 0,
        });
        return { next: providerError.retryable ? 'provider_retry' : 'final_provider_error' };
      }
      const resolved = classifyResolution(generation, request.outputSchema);
      const spend = priced(request.model, generation.usage);
      record(spend);
      const transcript: TranscriptClosing = {
        outcome: resolved.kind === 'answer' ? 'answered' : 'invalid_output',
        response: transcriptResponse(generation),
      };
      await deps.transcripts.close(callId, { transcript, ...spend });
      if (resolved.kind === 'answer') return { next: 'answered', output: resolved.output };
      logFailure(request, attempt, resolved.kind, null);
      return { next: 'output_retry' };
    };

    let providerRetries = 0;
    let outputRetries = 0;
    let last: 'none' | 'invalid_output' | 'provider_error' = 'none';
    for (let attempt = 1; ; attempt += 1) {
      if (deps.clock.now() >= request.notAfter) break;
      const step = await attemptOnce(attempt);
      if (step.next === 'answered') return { outcome: 'answered', output: step.output, usage: spent };
      if (step.next === 'final_provider_error') {
        last = 'provider_error';
        break;
      }
      if (step.next === 'output_retry') {
        last = 'invalid_output';
        if (outputRetries === INVALID_OUTPUT_RETRIES) break;
        outputRetries += 1;
        continue;
      }
      last = 'provider_error';
      if (providerRetries === PROVIDER_RETRIES) break;
      providerRetries += 1;
      await delay(providerRetryDelayMs(providerRetries));
    }
    return last === 'invalid_output'
      ? { outcome: 'invalid_output', usage: spent }
      : { outcome: 'failed', code: 'model_unavailable', usage: spent };
  };
}

function isBound(binding: AssessBinding | undefined): boolean {
  return Boolean(binding?.investigationId) || Boolean(binding?.selfCheckRunId);
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

function addUsage(total: AssessUsage, attempt: { usage: CallUsage | null; costUsd: number }): AssessUsage {
  const { usage } = attempt;
  if (usage === null) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    costUsd: total.costUsd + attempt.costUsd,
  };
}

/** The answer as the client returned it, before the schema check; the raw text only when it is not empty. */
function transcriptResponse(generation: RoleGeneration) {
  return {
    object: generation.object ?? null,
    finishReason: generation.finishReason ?? null,
    ...(generation.text === '' ? {} : { text: generation.text }),
  };
}
