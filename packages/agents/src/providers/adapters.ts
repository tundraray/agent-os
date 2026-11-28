import type { ModelProviderKind } from '@agent-os/contracts';
import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';

import type { JsonValue, TurnModel } from '../model/mastra-turn';
import { anthropicAdapter } from './anthropic-adapter';
import { geminiAdapter } from './gemini-adapter';
import { openAICompatibleAdapter } from './openai-compatible-adapter';
import type { ProviderConnection } from './provider-registry';

/** Whether the texts are kept (`document`) or are the question searched with (`query`). */
export type EmbeddingInputType = 'document' | 'query';

/** Provider options of a request or a message, keyed by the provider's name in the AI SDK. */
export type ProviderOptions = Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
>;

/** An AI SDK embedding model; the three provider packages share one `@ai-sdk/provider`. */
export type EmbeddingModel = ReturnType<
  OpenAICompatibleProvider['embeddingModel']
>;

/** The one request of the connection check: a `GET` of the provider's model list, no model is called (FR-15). */
export interface CheckRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ProviderEmbeddings {
  model(connection: ProviderConnection, modelName: string): EmbeddingModel;
  /**
   * What the kind tells the provider about the texts and the catalogue's `dimensions` of the vectors;
   * `undefined` when it tells nothing.
   */
  providerOptions(
    inputType: EmbeddingInputType,
    dimensions: number,
  ): ProviderOptions | undefined;
}

/**
 * Everything that depends on the provider's kind (KD-3): the AI SDK model on the connection's address and
 * key, the cache mark, the embeddings, the «tools not accepted» and context overflow markers of an error body and the check
 * request. Building a model touches no network; the key is read from the connection on every call (KD-1).
 */
export interface ProviderAdapter {
  languageModel(connection: ProviderConnection, modelName: string): TurnModel;
  /** The «cache up to here» mark of a message, or `null` when the provider caches the request's start itself. */
  readonly cacheMark: ProviderOptions | null;
  /** `null` when the kind serves no embedding models. */
  readonly embeddings: ProviderEmbeddings | null;
  /** Whether a rejection is about the request's tools (design-core.md, «Как разбирается ошибка провайдера»). */
  toolsRejected(statusCode: number, body: string): boolean;
  /**
   * Whether a rejection says the request does not fit the model's context window (runtime-fixes
   * design-steps.md KD-4): structured fields first, the provider's fixed error text where it has none.
   */
  contextOverflow(statusCode: number, body: string): boolean;
  checkRequest(connection: ProviderConnection): CheckRequest;
}

/**
 * The adapter of a kind. A function, not a constant map: the adapter files import `rejectionText` and `keyHeader` from here,
 * so the map is read only when called, after every module of the cycle has run.
 */
export function providerAdapter(kind: ModelProviderKind): ProviderAdapter {
  switch (kind) {
    case 'anthropic':
      return anthropicAdapter;
    case 'gemini':
      return geminiAdapter;
    case 'openai_compatible':
      return openAICompatibleAdapter;
  }
}

/** The header that carries the key, or no header when the provider has no key. */
export function keyHeader(
  name: string,
  value: string | null,
): Record<string, string> {
  return value === null ? {} : { [name]: value };
}

/** A rejection of a malformed request: only these statuses can carry the «tools not accepted» marker. */
const TOOLS_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/** The only status a context overflow is read from (runtime-fixes design-steps.md, «Как адаптер узнаёт переполнение»). */
const CONTEXT_OVERFLOW_STATUS = 400;

/**
 * The text fields of a provider's error body; empty strings when the body says none of them.
 * `errorType` is `metadata.error_type`, where OpenRouter names the error.
 */
export interface ProviderErrorText {
  readonly message: string;
  readonly param: string;
  readonly type: string;
  readonly code: string;
  readonly errorType: string;
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, name)
    : undefined;
}

function textField(value: unknown, name: string): string {
  const text = field(value, name);
  return typeof text === 'string' ? text : '';
}

/**
 * The fields of the error — under `error` as Anthropic, Gemini and OpenAI send it, or at the top of the body
 * as vLLM and Mistral do. A body that is not JSON gives empty strings.
 */
function errorText(body: string): ProviderErrorText {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const error =
    typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? parsed.error
      : parsed;
  return {
    message: textField(error, 'message'),
    param: textField(error, 'param'),
    type: textField(error, 'type'),
    code: textField(error, 'code'),
    errorType: textField(field(error, 'metadata'), 'error_type'),
  };
}

/** Reads a rejection for the «tools not accepted» marker: `null` unless the status is 400 or 422. */
export function rejectionText(
  statusCode: number,
  body: string,
): ProviderErrorText | null {
  return TOOLS_REJECTION_STATUSES.has(statusCode) ? errorText(body) : null;
}

/** Reads a rejection for the context overflow marker: `null` unless the status is 400. */
export function overflowText(
  statusCode: number,
  body: string,
): ProviderErrorText | null {
  return statusCode === CONTEXT_OVERFLOW_STATUS ? errorText(body) : null;
}
