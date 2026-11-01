import type { ProcessConfig } from '../config/process-config.schema.js';

export type RoleEffort = ProcessConfig['roles']['worker']['effort'];

/** One message of a role packet; the role instructions travel separately as `system`. */
export interface RoleMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
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
 */
export type TokenCountResult =
  | { readonly outcome: 'counted'; readonly inputTokens: number }
  | { readonly outcome: 'failed'; readonly statusCode: number | null };

/** Port that counts the input tokens of a role packet before its reservation (KD-4). */
export interface TokenCounter {
  countInputTokens(
    request: TokenCountRequest,
    signal: AbortSignal,
  ): Promise<TokenCountResult>;
}
