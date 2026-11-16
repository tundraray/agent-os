import type { Logger } from '@agent-os/common';
import { type CallUsage, type Clock, type Runtime, systemClock } from '@agent-os/runtime';
import {
  type AccessAudit,
  type AccessDeniedEntry,
  type AccessGate,
  type ModelVerdict,
  OwnerDisabledError,
} from '../access-gate.js';
import type { AgentsConfig } from '../config.js';
import type {
  AgentToolCall,
  AgentToolDefinition,
  AgentTurnCall,
  AgentTurnGeneration,
  AgentTurnMessage,
  AgentTurnModelClient,
} from './mastra-turn.js';
import { DATA_PREAMBLE } from './provider-messages.js';
import { classifyRejection, PROVIDER_RETRIES, type ProviderError, providerRetryDelayMs } from './retry-policy.js';

/**
 * When to reach for `run_code` (code-execution PRD FR-01, AC-01.3): appended after the data preamble
 * to the instructions of every model call of an agent.
 */
const CODE_RULE = [
  'Use run_code when a direct tool result came back cut, when you need to count, aggregate or match data,',
  'or when the work is a chain of more than three or four tool calls. Otherwise call tools directly.',
  'In a script, call tools with callTool under the same names as in your tool list (mcp__<server>__<tool>)',
  'and with the same arguments their schemas describe.',
  "When a tool called from a script fails with a tool error, the script gets only the outcome, without the server's",
  'message; to see the message, call that tool directly.',
].join('\n');

/**
 * One text part of an agent's model call (KD-3): `offset` — where the part starts in the text of this
 * attempt; a retry starts again at 0. Parts are not stored anywhere.
 */
export interface TextDelta {
  readonly ownerId: string;
  readonly rootId: string;
  readonly agentId: string;
  readonly offset: number;
  readonly text: string;
}

/** The receiver of text parts given to `createAgents`; its failure is logged and never breaks the step. */
export type OnTextDelta = (delta: TextDelta) => void;

export interface ModelClientDeps {
  /** The seam of the model: Mastra in production, a scripted double in tests (plan Notes 9). */
  readonly turnClient: AgentTurnModelClient;
  readonly ledger: Pick<Runtime['ledger'], 'record'>;
  readonly config: Pick<AgentsConfig, 'maxOutputTokens' | 'defaultModel'>;
  /** The package logger: `completeText` runs outside any step. */
  readonly logger: Logger;
  /** Asked once before the first attempt of every call: a refused call does not start (KD-4). */
  readonly access: Pick<AccessGate, 'model'>;
  /** Gets the `access_denied` record of a refused title (KD-6); a step's refusal is audited by the step. */
  readonly audit: AccessAudit;
  /** Gets every text part of an agent turn; none by default. */
  readonly onTextDelta?: OnTextDelta;
  /** Times the pauses between retries; the real clock by default. */
  readonly clock?: Clock;
}

/** One model call of an agent session. */
export interface ModelCallRequest {
  readonly ownerId: string;
  /** The root of the agent's tree: the hook's receiver finds the conversation by it. */
  readonly rootId: string;
  /** The agent's id (its task). */
  readonly taskId: string;
  /** The definition's name: the id of the request agent Mastra builds. */
  readonly agentName: string;
  /** The session's model (`anthropic/…`), an id of the model catalogue (Invariant 6). */
  readonly model: string;
  /** The definition's prompt; the data preamble and the code rule are appended here. */
  readonly instructions: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolDefinition[];
  /** Whether the text parts go to `onTextDelta`: an answer of the agent does, a compaction summary does not. */
  readonly streamsText: boolean;
  /** The step's signal: a cancel ends the call or the pause with an exception, never with a retry. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

/** A one-off text of the model outside any task, such as a conversation title. */
export interface CompleteTextRequest {
  readonly ownerId: string;
  /** The system block of the call. */
  readonly system: string;
  /** The one user message. */
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** A cancel ends the call or the pause with an exception, never with a retry. */
  readonly signal: AbortSignal;
}

/** The model answered; its call is in the token ledger as `modelCallId`. */
export interface ModelAnswer {
  readonly kind: 'answer';
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: CallUsage;
  readonly modelCallId: string;
}

/** The provider kept failing: a final status, or a retryable one after both retries. */
export interface ModelError {
  readonly kind: 'model_error';
  readonly error: ProviderError;
}

/** A refusal of the access gate for a model call. */
export type ModelRefusal = Extract<ModelVerdict, { readonly kind: 'refused' }>;

/** `AccessGate` refused the model call: it did not start (KD-4). */
export interface ModelNotStarted {
  readonly kind: 'not_started';
  readonly verdict: ModelRefusal;
}

export type ModelCallResult = ModelAnswer | ModelError | ModelNotStarted;

/** The only place the package calls the model (KD-6). */
export interface ModelClient {
  /**
   * Asks `AccessGate.model` once, before the first attempt: a refusal gives `not_started` with the
   * verdict and the model is not called; provider retries are not checked again.
   */
  call(request: ModelCallRequest): Promise<ModelCallResult>;
  /**
   * One call of `AGENT_DEFAULT_MODEL` without tools and outside any task: the same verdict, retries
   * and cancel as `call`, a ledger row without `taskId`, no text parts to the hook. A provider that
   * keeps failing rejects with an error that names the status. A refused call rejects before the call:
   * a disabled owner with `OwnerDisabledError`, any other refusal after its `access_denied` record.
   */
  completeText(request: CompleteTextRequest): Promise<string>;
}

/** The `access_denied` record of a refused model call (KD-6). */
export function modelDeniedEntry(ownerId: string, model: string, refusal: ModelRefusal): AccessDeniedEntry {
  return {
    kind: 'access_denied',
    actor: ownerId,
    objectType: 'model',
    objectId: model,
    outcome: 'rejected',
    reason: refusal.reason,
  };
}

/** Why a model call did not start, in words for the failure and the logs; amounts in USD. */
export function modelRefusalMessage(ownerId: string, model: string, refusal: ModelRefusal): string {
  switch (refusal.reason) {
    case 'owner_disabled':
      return `Owner ${ownerId} is disabled or unknown`;
    case 'quota_exhausted':
      return (
        `The ${refusal.month} quota of ${refusal.quotaUsd} USD for model ${model} ` +
        `is spent (${refusal.spentUsd} USD)`
      );
    case 'model_not_connected':
      return `Model ${model} is not in the model catalogue`;
    case 'model_not_allowed':
      return `Model ${model} is not allowed to owner ${ownerId}`;
    case 'no_models_allowed':
      return `Owner ${ownerId} has no models allowed`;
  }
}

/** The log fields of a refusal: the reason, and the spend, quota and month of a spent quota. */
export function refusalFields(refusal: ModelRefusal): Record<string, unknown> {
  return refusal.reason === 'quota_exhausted'
    ? { reason: refusal.reason, spentUsd: refusal.spentUsd, quotaUsd: refusal.quotaUsd, month: refusal.month }
    : { reason: refusal.reason };
}

/** What one attempt sends; `onText` gets the parts of this attempt only. */
interface Attempt {
  readonly call: AgentTurnCall;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** A fresh receiver of text parts per attempt, so a retry starts its offsets again at 0. */
  readonly onText: () => (text: string) => void;
}

/** The answer of the provider, or its final error after the retries. */
type Generated = { readonly kind: 'generated'; readonly generation: AgentTurnGeneration; readonly durationMs: number } | ModelError;

/**
 * The model wrapper of KD-6 and KD-3: one streamed request through the turn client, up to two retries
 * of a provider error with pauses of 1000 and 3000 ms, a cancel that is never retried, and the token
 * ledger row written right after the answer — by its own statement, so it stays when the step is lost.
 * Each text part of an agent's answer goes to `onTextDelta` with its running `offset`; a retry starts
 * the parts again at offset 0.
 */
export function createModelClient(deps: ModelClientDeps): ModelClient {
  const { turnClient, ledger, config, access } = deps;
  const clock = deps.clock ?? systemClock;

  /** The gate's verdict for one call, asked once before the first attempt; a refusal is logged. */
  async function verdictOf(ownerId: string, model: string, logger: Logger): Promise<ModelVerdict> {
    const verdict = await access.model(ownerId, model);
    if (verdict.kind === 'refused') {
      logger.warn('access gate refused a model call', { ownerId, model, ...refusalFields(verdict) });
    }
    return verdict;
  }

  /** Runs the attempts until an answer, a final provider error, or a cancel (thrown). */
  async function generate(attempt: Attempt): Promise<Generated> {
    for (let retries = 0; ; retries += 1) {
      attempt.signal.throwIfAborted();
      const startedAt = clock.now().getTime();
      try {
        const generation = await turnClient.streamTurn(attempt.call, {
          signal: attempt.signal,
          onText: attempt.onText(),
        });
        return { kind: 'generated', generation, durationMs: clock.now().getTime() - startedAt };
      } catch (error) {
        attempt.signal.throwIfAborted();
        const providerError = classifyRejection(error);
        if (providerError === null) throw error;
        attempt.logger.warn('model call failed', {
          model: attempt.call.model,
          statusCode: providerError.statusCode,
          retryable: providerError.retryable,
          attempt: retries + 1,
          durationMs: clock.now().getTime() - startedAt,
        });
        if (!providerError.retryable || retries === PROVIDER_RETRIES) {
          return { kind: 'model_error', error: providerError };
        }
        await pause(clock, providerRetryDelayMs(retries + 1), attempt.signal);
      }
    }
  }

  /** The text parts of one attempt of an agent's call, with offsets from 0, to the hook. */
  function deltaReceiver(request: ModelCallRequest): () => (text: string) => void {
    const onTextDelta = deps.onTextDelta;
    if (onTextDelta === undefined || !request.streamsText) return () => () => {};
    return () => {
      let offset = 0;
      return (text) => {
        const delta: TextDelta = {
          ownerId: request.ownerId,
          rootId: request.rootId,
          agentId: request.taskId,
          offset,
          text,
        };
        offset += text.length;
        deliver(onTextDelta, delta, request.logger);
      };
    };
  }

  return {
    async call(request) {
      const verdict = await verdictOf(
        request.ownerId,
        request.model,
        request.logger.child({ agentId: request.taskId, taskId: request.taskId }),
      );
      if (verdict.kind === 'refused') return { kind: 'not_started', verdict };
      const result = await generate({
        call: {
          purpose: 'agent_turn',
          agentName: request.agentName,
          model: request.model,
          instructions: `${request.instructions}\n\n${DATA_PREAMBLE}\n\n${CODE_RULE}`,
          messages: request.messages,
          tools: request.tools,
          maxOutputTokens: config.maxOutputTokens,
        },
        signal: request.signal,
        logger: request.logger,
        onText: deltaReceiver(request),
      });
      if (result.kind === 'model_error') return result;
      const { generation, durationMs } = result;
      const { usage } = generation;
      const { callId } = await ledger.record({
        ownerId: request.ownerId,
        taskId: request.taskId,
        model: request.model,
        price: verdict.price,
        usage,
      });
      request.logger.info('model call answered', {
        model: request.model,
        callId,
        ...usage,
        toolCalls: generation.toolCalls.length,
        finishReason: generation.finishReason,
        durationMs,
      });
      return {
        kind: 'answer',
        text: generation.text,
        toolCalls: generation.toolCalls,
        usage,
        modelCallId: callId,
      };
    },

    async completeText(request) {
      const model = config.defaultModel;
      const logger = deps.logger.child({ ownerId: request.ownerId });
      // A refusal is the caller's error to handle (the conversation title logs it, DC-7).
      const verdict = await verdictOf(request.ownerId, model, logger);
      if (verdict.kind === 'refused') {
        if (verdict.reason === 'owner_disabled') throw new OwnerDisabledError(request.ownerId);
        await deps.audit(modelDeniedEntry(request.ownerId, model, verdict));
        throw new Error(modelRefusalMessage(request.ownerId, model, verdict));
      }
      const result = await generate({
        call: {
          purpose: 'complete_text',
          agentName: 'complete-text',
          model,
          instructions: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          tools: [],
          maxOutputTokens: request.maxOutputTokens,
        },
        signal: request.signal,
        logger,
        onText: () => () => {},
      });
      if (result.kind === 'model_error') {
        const status = result.error.statusCode === null ? 'no status' : `status ${result.error.statusCode}`;
        throw new Error(`Model ${model} kept failing on completeText (${status})`);
      }
      const { usage } = result.generation;
      const { callId } = await ledger.record({
        ownerId: request.ownerId,
        model,
        price: verdict.price,
        usage,
      });
      logger.info('model text completed', {
        model,
        callId,
        ...usage,
        durationMs: result.durationMs,
      });
      return result.generation.text;
    },
  };
}

/** Gives a part to the hook; a failure of the hook is a `warn` and nothing more. */
function deliver(onTextDelta: OnTextDelta, delta: TextDelta, logger: Logger): void {
  try {
    onTextDelta(delta);
  } catch (error) {
    logger.warn('text delta hook failed', {
      agentId: delta.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Waits on the clock; a cancel ends the wait with the signal's reason. */
function pause(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      cancelTimer();
      reject(signal.reason);
    };
    const cancelTimer = clock.setTimer(ms, () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
