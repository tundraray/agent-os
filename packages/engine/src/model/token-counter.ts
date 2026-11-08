import type { ProcessConfig } from '../config/process-config.schema.js';
import type { AgentToolChoice, AgentTurnMessage } from './role-agent.js';

export type RoleEffort = ProcessConfig['roles']['worker']['effort'];

/** One message of a role packet; the role instructions travel separately as `system`. */
export interface RoleMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /**
   * The provider cache mark ends at this message (KD-6): it closes the stable block of the controller input, so the
   * provider caches the input up to here. Only the controller packet sets it; a counted input is the same with or without it.
   */
  readonly cacheMark?: boolean;
}

/**
 * What the role call sends, in the form the provider counts (KD-4): the counter sees the same
 * instructions, messages, effort and output JSON schema as the call itself.
 */
export interface TokenCountRequest {
  /** Catalog id, `provider/model`. */
  readonly model: string;
  readonly system: string;
  readonly messages: readonly RoleMessage[];
  readonly effort: RoleEffort;
  /** JSON schema of the role output, sent as the native `json_schema` output format. */
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

/**
 * The count, or a refusal: a network failure (`statusCode` null) or a non-2xx answer. A refusal
 * is handled by `ModelGateway` like a provider error of the model call (retries, then DC-12).
 * `errorClass` is the class of the refusal for the log — the provider's `error.type` of a non-2xx
 * answer (`invalid_request_error`, `overloaded_error`, …), `network_error` or `invalid_response` —
 * never the provider's message, which may quote the request.
 */
export type TokenCountResult =
  | { readonly outcome: 'counted'; readonly inputTokens: number }
  | { readonly outcome: 'failed'; readonly statusCode: number | null; readonly errorClass: string };

/** A tool of an agent turn as the provider counts it: the same name, description and argument JSON schema the turn sends. */
export interface CountedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * What an agent turn sends, in the form the provider counts (design-agent-core.md, DC-30; plan Notes 1.10): the whole
 * input of the turn — its system block, the messages of the view with their tool calls and results, and the tool
 * schemas — as a role call's count takes its output schema.
 */
export interface AgentTurnCountRequest {
  /** Catalog id, `provider/model`. */
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly CountedTool[];
  readonly toolChoice: AgentToolChoice;
  readonly effort: RoleEffort;
}

/**
 * Port that counts the input tokens of a model request before its reservation: a role packet (KD-4) or an agent turn
 * (DC-30). A refusal of either is handled by `ModelGateway` like a provider error.
 */
export interface TokenCounter {
  countInputTokens(
    request: TokenCountRequest,
    signal: AbortSignal,
  ): Promise<TokenCountResult>;
  countTurnInputTokens(request: AgentTurnCountRequest, signal: AbortSignal): Promise<TokenCountResult>;
}
