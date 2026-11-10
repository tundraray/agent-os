import type { AgentDefinition } from '../config/agent-config.schema.js';
import type { AgentToolChoice, AgentTurnMessage } from './role-agent.js';

export type RoleEffort = AgentDefinition['effort'];

/** One message of a call outside an agent turn (`Engine.assess`); the instructions travel separately as `system`. */
export interface RoleMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * The count, or a refusal: a network failure (`statusCode` null) or a non-2xx answer. A refusal
 * is handled by `ModelGateway` like a provider error of the turn (retries, then DC-12).
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
 * schemas.
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
 * Port that counts the input tokens of an agent turn before its reservation (DC-30). A refusal is handled by
 * `ModelGateway` like a provider error.
 */
export interface TokenCounter {
  countTurnInputTokens(request: AgentTurnCountRequest, signal: AbortSignal): Promise<TokenCountResult>;
}
