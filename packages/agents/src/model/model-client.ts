import type { Logger } from '@agent-os/common';
import { type AgentFailureReason, modelProvider } from '@agent-os/contracts';
import {
  type CallUsage,
  CLOCK,
  type Clock,
  TokenLedger,
} from '@agent-os/runtime';
import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  type AccessAudit,
  type AccessDeniedEntry,
  type AccessGate,
  ModelNotConfiguredError,
  ModelRefusedError,
  type ModelVerdict,
  OwnerDisabledError,
} from '../access-gate';
import {
  ACCESS_AUDIT,
  ACCESS_GATE,
  AGENT_TURN_CLIENT,
  AGENTS_CONFIG,
  AGENTS_LOGGER,
  ON_TEXT_DELTA,
} from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { providerAdapter } from '../providers/adapters';
import { providerReadiness } from '../providers/provider-readiness';
import {
  AgentsProviders,
  type ProviderConnection,
} from '../providers/provider-registry';
import { TrainingBudget } from '../training/training-budget';
import type {
  AgentToolCall,
  AgentToolDefinition,
  AgentTurnCall,
  AgentTurnGeneration,
  AgentTurnMessage,
  AgentTurnModelClient,
} from './mastra-turn';
import { DATA_PREAMBLE } from './provider-messages';
import {
  classifyRejection,
  PROVIDER_RETRIES,
  type ProviderError,
  type ProviderRejectionReason,
  pause,
  providerRetryDelayMs,
} from './retry-policy';
import { tokensOfBytes, utf8Bytes } from './token-estimate';

/**
 * How to read a stored result and when to reach for `run_code` (code-execution PRD FR-01, AC-01.3):
 * appended after the data preamble to the instructions of every model call of an agent.
 */
export const CODE_RULE = [
  'When a tool result comes to you as a stored result, read it in parts with read_tool_result or find lines with',
  'search_tool_result; before a summary or an analysis of it, read all of it or say which part you read.',
  'Use run_code to count, aggregate or match data, also over a stored result (readResult), or when the work is',
  'a chain of more than three or four tool calls. Otherwise call tools directly.',
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

/** The receiver of text parts provided as `ON_TEXT_DELTA`; its failure is logged and never breaks the step. */
export type OnTextDelta = (delta: TextDelta) => void;

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
  /** The caller is in a training tree (`ToolCaller.training`): the training budget is asked first (KD-5). */
  readonly training: boolean;
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
  /**
   * The provider ended the answer at the output length limit (finish reason `length`, KD-3). Not a model
   * error: the caller decides what a cut answer means.
   */
  readonly cutOff: boolean;
}

/** Why a model call failed on the provider's side: its state before the request, or its rejection (KD-2). */
export type ModelFailureReason = Extract<
  AgentFailureReason,
  | 'model_error'
  | 'provider_missing'
  | 'provider_disabled'
  | 'provider_key_missing'
  | 'provider_key_rejected'
  | 'provider_unavailable'
  | 'provider_tools_rejected'
>;

/**
 * The provider is not ready (no request was sent), or it kept failing: a final status, or a retryable one
 * after both retries. Not a refusal of rights: nothing is audited (DC-10).
 */
export interface ModelError {
  readonly kind: 'model_error';
  readonly reason: ModelFailureReason;
  /** The provider's name, the first part of the model id. */
  readonly provider: string;
  /** The provider's last status; `null` — no request, a network failure or a timeout. */
  readonly statusCode: number | null;
}

/** A refusal of the access gate for a model call. */
export type ModelRefusal = Extract<ModelVerdict, { readonly kind: 'refused' }>;

/** `AccessGate` refused the model call: it did not start (KD-4). */
export interface ModelNotStarted {
  readonly kind: 'not_started';
  readonly verdict: ModelRefusal;
}

export type ModelCallResult = ModelAnswer | ModelError | ModelNotStarted;

/** The `access_denied` record of a refused model call (KD-6). */
export function modelDeniedEntry(
  ownerId: string,
  model: string,
  refusal: ModelRefusal,
): AccessDeniedEntry {
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
export function modelRefusalMessage(
  ownerId: string,
  model: string,
  refusal: ModelRefusal,
): string {
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
    ? {
        reason: refusal.reason,
        spentUsd: refusal.spentUsd,
        quotaUsd: refusal.quotaUsd,
        month: refusal.month,
      }
    : { reason: refusal.reason };
}

/**
 * The message of a `model_error` failure: the model, the provider, the reason and the last status — never the
 * request or the provider's body, which only the log carries.
 */
export function modelErrorMessage(model: string, error: ModelError): string {
  const status =
    error.statusCode === null ? '' : `, status ${error.statusCode}`;
  return `Model ${model} of provider ${error.provider} failed: ${error.reason}${status}`;
}

/** The chat's reason of a provider rejection: any other status is the chat's `model_error`. */
function chatReason(reason: ProviderRejectionReason): ModelFailureReason {
  return reason === 'provider_error' ? 'model_error' : reason;
}

/** The provider's connection when it is ready to take the request. */
interface Connected {
  readonly kind: 'connected';
  readonly connection: ProviderConnection;
}

/** What one attempt sends; `onText` gets the parts of this attempt only. */
interface Attempt {
  readonly call: AgentTurnCall;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** A fresh receiver of text parts per attempt, so a retry starts its offsets again at 0. */
  readonly onText: () => (text: string) => void;
  /** Writes the ledger row of one attempt at the verdict's price. */
  readonly record: (usage: CallUsage) => Promise<{ readonly callId: string }>;
}

/** The answer of the provider with the id of its ledger row, or the provider's final error after the retries. */
type Generated =
  | {
      readonly kind: 'generated';
      readonly generation: AgentTurnGeneration;
      readonly callId: string;
      readonly durationMs: number;
    }
  | ModelError;

/**
 * The bytes of a request: the instructions, the messages and the tools with the JSON Schemas of the
 * MCP ones. A built-in tool's zod schema is not serialized, so it counts by its name and description.
 */
function requestBytes(call: AgentTurnCall): number {
  const tools = call.tools.map(({ name, description, inputSchema }) => [
    name,
    description,
    '_zod' in inputSchema ? null : inputSchema,
  ]);
  return (
    utf8Bytes(call.instructions) +
    utf8Bytes(JSON.stringify([call.messages, tools]))
  );
}

/**
 * The usage of an attempt that did not finish: the provider reports usage only when the stream finishes,
 * so the row is an estimate — the whole request as uncached input, the streamed text as output.
 */
function estimatedUsage(sentBytes: number, streamedBytes: number): CallUsage {
  return {
    inputTokens: tokensOfBytes(sentBytes),
    outputTokens: tokensOfBytes(streamedBytes),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * An answer whose provider reported no input tokens (some OpenAI-compatible servers): its usage is the
 * estimate of an unfinished attempt — the request and the answer's text in UTF-8 bytes (DC-11). Any other
 * answer is returned as it is. The turn client reports a missing count as zero, and a request is never empty.
 */
function withReportedInput(
  generation: AgentTurnGeneration,
  sentBytes: number,
): AgentTurnGeneration {
  if (generation.usage.inputTokens > 0) return generation;
  return {
    ...generation,
    usage: estimatedUsage(sentBytes, utf8Bytes(generation.text)),
  };
}

/**
 * Whether the provider bills an attempt that did not finish — the one place that decides. It does once the
 * answer began (a text part arrived before the failure, whatever the failure is), and when a cancel cut a
 * request that was sent. It does not when the provider rejected the request before any output: an HTTP
 * error answer (429, 5xx, 529) or a network failure before the stream, which is what an `AI_APICallError`
 * without a text part is — also when a cancel arrived at the same moment.
 */
function isBilled(cut: {
  readonly streamedBytes: number;
  readonly aborted: boolean;
  readonly providerError: ProviderError | null;
}): boolean {
  return cut.streamedBytes > 0 || (cut.aborted && cut.providerError === null);
}

/**
 * The only place the package calls the model (KD-6). The model wrapper of KD-6 and KD-3: one streamed
 * request through the turn client, up to two retries of a provider error with pauses of 1000 and 3000 ms, a cancel that is never retried, and one token
 * ledger row per billed attempt — by its own statement, so it stays when the step is lost. An answered
 * attempt is recorded with the provider's usage; an attempt cut by a cancel, or by a failure after its
 * answer began, with an estimate, so a call interrupted before its answer ends still counts against the
 * quota. An attempt the provider rejected before any output is not billed and leaves no row (`isBilled`).
 * Each text part of an agent's answer goes to `onTextDelta` with its running `offset`; a retry starts
 * the parts again at offset 0.
 */
@Injectable()
export class ModelClient {
  /** The package logger: `completeText` runs outside any step. */
  private readonly logger: Logger;

  constructor(
    /** The seam of the model: Mastra in production, a scripted double in tests (plan Notes 9). */
    @Inject(AGENT_TURN_CLIENT)
    private readonly turnClient: AgentTurnModelClient,
    @Inject(TokenLedger) private readonly ledger: Pick<TokenLedger, 'record'>,
    @Inject(AGENTS_CONFIG)
    private readonly config: Pick<AgentsConfig, 'maxOutputTokens'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
    /**
     * Asked once before the first attempt of every call: a refused call does not start (KD-4). `completeText`
     * takes its model from `defaultChatModel`.
     */
    @Inject(ACCESS_GATE)
    private readonly access: Pick<AccessGate, 'model' | 'defaultChatModel'>,
    /** The provider's connection, read after the verdict on every call, never kept (KD-2, ADR-0019). */
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    /** Gets the `access_denied` record of a refused title (KD-6); a step's refusal is audited by the step. */
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    /** Times the pauses between retries. */
    @Inject(CLOCK) private readonly clock: Clock,
    /** Asked before every call of a training tree, and only then (self-learning design-training.md KD-5). */
    @Inject(TrainingBudget)
    private readonly budget: Pick<TrainingBudget, 'check'>,
    /** Gets every text part of an agent turn; none by default. */
    @Optional()
    @Inject(ON_TEXT_DELTA)
    private readonly onTextDelta?: OnTextDelta,
  ) {
    this.logger = logger.child({ service: 'agents.model' });
  }

  /**
   * Asks `AccessGate.model` once, before the first attempt: a refusal gives `not_started` with the
   * verdict and the model is not called; provider retries are not checked again. Then reads the provider's
   * connection: a provider that is not ready gives `model_error` with its reason, without a request. An
   * answered attempt is a ledger row, and so is one cut by a cancel or by a failure after its answer began;
   * an attempt the provider rejected before any output is not.
   */
  async call(request: ModelCallRequest): Promise<ModelCallResult> {
    // At the cap the budget has already stopped the tree and cut off the calling step, which leaves without writes.
    if (request.training && (await this.budget.check(request)) === 'capped') {
      request.logger.warn('model call refused: training cap reached', {
        rootId: request.rootId,
        taskId: request.taskId,
        model: request.model,
      });
      throw new Error(`Training ${request.rootId} reached its spending cap`);
    }
    const verdict = await this.verdictOf(
      request.ownerId,
      request.model,
      request.logger.child({ agentId: request.taskId, taskId: request.taskId }),
    );
    if (verdict.kind === 'refused') return { kind: 'not_started', verdict };
    const connected = await this.connectionOf(request.model, request.logger);
    if (connected.kind === 'model_error') return connected;
    const result = await this.generate({
      call: {
        purpose: 'agent_turn',
        agentName: request.agentName,
        model: request.model,
        connection: connected.connection,
        instructions: `${request.instructions}\n\n${DATA_PREAMBLE}\n\n${CODE_RULE}`,
        messages: request.messages,
        tools: request.tools,
        maxOutputTokens: this.config.maxOutputTokens,
      },
      signal: request.signal,
      logger: request.logger,
      onText: this.deltaReceiver(request),
      record: (usage) =>
        this.ledger.record({
          ownerId: request.ownerId,
          taskId: request.taskId,
          model: request.model,
          price: verdict.price,
          usage,
        }),
    });
    if (result.kind === 'model_error') return result;
    const { generation, callId, durationMs } = result;
    const { usage } = generation;
    const cutOff = generation.finishReason === 'length';
    request.logger.info('model call answered', {
      model: request.model,
      provider: connected.connection.name,
      callId,
      ...usage,
      toolCalls: generation.toolCalls.length,
      finishReason: generation.finishReason,
      cutOff,
      durationMs,
    });
    return {
      kind: 'answer',
      text: generation.text,
      toolCalls: generation.toolCalls,
      usage,
      modelCallId: callId,
      cutOff,
    };
  }

  /**
   * One call of the default chat model (`AccessGate.defaultChatModel`) without tools and outside any task:
   * the same verdict, provider readiness, retries and cancel as `call`, a ledger row without `taskId`, no
   * text parts to the hook. No default chat model rejects with `ModelNotConfiguredError` before anything
   * else. A provider that is not ready or keeps failing rejects with an error that names the reason. A
   * refused call rejects before the call: a disabled owner with `OwnerDisabledError`, any other refusal
   * with `ModelRefusedError` after its `access_denied` record.
   */
  async completeText(request: CompleteTextRequest): Promise<string> {
    const logger = this.logger.child({ ownerId: request.ownerId });
    // Every refusal below is the caller's error to handle (the conversation title logs it, DC-7, DC-3).
    const model = await this.access.defaultChatModel();
    if (model === null) {
      logger.warn('completeText refused: no default chat model', {
        reason: 'model_not_configured',
      });
      throw new ModelNotConfiguredError();
    }
    const verdict = await this.verdictOf(request.ownerId, model, logger);
    if (verdict.kind === 'refused') {
      if (verdict.reason === 'owner_disabled')
        throw new OwnerDisabledError(request.ownerId);
      await this.audit(modelDeniedEntry(request.ownerId, model, verdict));
      throw new ModelRefusedError(
        verdict.reason,
        modelRefusalMessage(request.ownerId, model, verdict),
      );
    }
    const connected = await this.connectionOf(model, logger);
    if (connected.kind === 'model_error')
      throw new Error(modelErrorMessage(model, connected));
    const result = await this.generate({
      call: {
        purpose: 'complete_text',
        agentName: 'complete-text',
        model,
        connection: connected.connection,
        instructions: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        tools: [],
        maxOutputTokens: request.maxOutputTokens,
      },
      signal: request.signal,
      logger,
      onText: () => () => {},
      record: (usage) =>
        this.ledger.record({
          ownerId: request.ownerId,
          model,
          price: verdict.price,
          usage,
        }),
    });
    if (result.kind === 'model_error')
      throw new Error(modelErrorMessage(model, result));
    logger.info('model text completed', {
      model,
      provider: connected.connection.name,
      callId: result.callId,
      ...result.generation.usage,
      durationMs: result.durationMs,
    });
    return result.generation.text;
  }

  /**
   * The provider's connection read now, after the verdict (KD-2): a provider that is not ready is a
   * `model_error` with its reason and no request — not a refusal of rights, so it is not audited (DC-10).
   */
  private async connectionOf(
    model: string,
    logger: Logger,
  ): Promise<Connected | ModelError> {
    const provider = modelProvider(model);
    const connection = await this.providers.connection(provider);
    const readiness = providerReadiness(connection);
    if (connection !== null && readiness === 'ready')
      return { kind: 'connected', connection };
    const reason: ModelFailureReason =
      readiness === 'disabled'
        ? 'provider_disabled'
        : readiness === 'key_missing'
          ? 'provider_key_missing'
          : 'provider_missing';
    logger.warn('model provider not ready', { model, provider, reason });
    return { kind: 'model_error', reason, provider, statusCode: null };
  }

  /** The gate's verdict for one call, asked once before the first attempt; a refusal is logged. */
  private async verdictOf(
    ownerId: string,
    model: string,
    logger: Logger,
  ): Promise<ModelVerdict> {
    const verdict = await this.access.model(ownerId, model);
    if (verdict.kind === 'refused') {
      logger.warn('access gate refused a model call', {
        ownerId,
        model,
        ...refusalFields(verdict),
      });
    }
    return verdict;
  }

  /**
   * Runs the attempts until an answer, a final provider error, or a cancel (thrown). An answered attempt
   * leaves one ledger row, an unfinished one only when `isBilled` says so.
   */
  private async generate(attempt: Attempt): Promise<Generated> {
    const sentBytes = requestBytes(attempt.call);
    const { connection } = attempt.call;
    const adapter = providerAdapter(connection.kind);
    for (let retries = 0; ; retries += 1) {
      attempt.signal.throwIfAborted();
      const startedAt = this.clock.now().getTime();
      const onText = attempt.onText();
      let streamedBytes = 0;
      let generation: AgentTurnGeneration;
      try {
        generation = await this.turnClient.streamTurn(attempt.call, {
          signal: attempt.signal,
          onText: (text) => {
            streamedBytes += utf8Bytes(text);
            onText(text);
          },
        });
      } catch (error) {
        const providerError = classifyRejection(error, adapter);
        const { aborted } = attempt.signal;
        if (isBilled({ streamedBytes, aborted, providerError })) {
          const usage = estimatedUsage(sentBytes, streamedBytes);
          const { callId } = await attempt.record(usage);
          attempt.logger.warn(
            'unfinished model attempt recorded with estimated usage',
            {
              model: attempt.call.model,
              callId,
              ...usage,
              estimated: true,
              aborted,
              attempt: retries + 1,
              durationMs: this.clock.now().getTime() - startedAt,
            },
          );
        }
        attempt.signal.throwIfAborted();
        if (providerError === null) throw error;
        // The logger's mask hides any remembered key the provider might echo in its body (KD-7).
        attempt.logger.warn('model call failed', {
          model: attempt.call.model,
          provider: connection.name,
          reason: providerError.reason,
          statusCode: providerError.statusCode,
          responseBody: providerError.responseBody,
          retryable: providerError.retryable,
          attempt: retries + 1,
          durationMs: this.clock.now().getTime() - startedAt,
        });
        if (!providerError.retryable || retries === PROVIDER_RETRIES) {
          return {
            kind: 'model_error',
            reason: chatReason(providerError.reason),
            provider: connection.name,
            statusCode: providerError.statusCode,
          };
        }
        await pause(
          this.clock,
          providerRetryDelayMs(retries + 1),
          attempt.signal,
        );
        continue;
      }
      const answered = withReportedInput(generation, sentBytes);
      const { callId } = await attempt.record(answered.usage);
      if (answered !== generation) {
        attempt.logger.warn(
          'model answer without input tokens recorded with estimated usage',
          {
            model: attempt.call.model,
            provider: connection.name,
            callId,
            ...answered.usage,
            estimated: true,
            attempt: retries + 1,
          },
        );
      }
      return {
        kind: 'generated',
        generation: answered,
        callId,
        durationMs: this.clock.now().getTime() - startedAt,
      };
    }
  }

  /** The text parts of one attempt of an agent's call, with offsets from 0, to the hook. */
  private deltaReceiver(
    request: ModelCallRequest,
  ): () => (text: string) => void {
    const onTextDelta = this.onTextDelta;
    if (onTextDelta === undefined || !request.streamsText)
      return () => () => {};
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
}

/** Gives a part to the hook; a failure of the hook is a `warn` and nothing more. */
function deliver(
  onTextDelta: OnTextDelta,
  delta: TextDelta,
  logger: Logger,
): void {
  try {
    onTextDelta(delta);
  } catch (error) {
    logger.warn('text delta hook failed', {
      agentId: delta.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
