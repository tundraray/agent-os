import type { MastraModelConfig } from '@mastra/core/llm';

/**
 * A ready model instance a role `Agent` takes as `model` — the language model object form of
 * `MastraModelConfig`, never a string id or a `{ id, url }` config (KD-7: a config with `url`
 * sends Mastra to the OpenAI-compatible client). The engine passes it to the role agent unchanged.
 */
export type RoleModel = Extract<MastraModelConfig, { doGenerate: unknown }>;

/**
 * Port of the assembly point (design-engine.md, Contract Definitions): by a catalog model id
 * (`anthropic/…`) returns the model instance of the role agents. It does not touch the network;
 * `createEngine` resolves every role model when it is created, so a throwing port refuses creation.
 * In `apps/api` it is an Anthropic Messages client on `RESEARCH_ANTHROPIC_BASE_URL` + `/v1`.
 */
export type ResolveModel = (modelId: string) => RoleModel;

/**
 * Fields of an engine log line: identifiers, roles, models, tokens and outcome classes only —
 * never a prompt, evidence content or a model answer (Security Considerations).
 */
export interface EngineLogFields {
  investigationId?: string;
  taskId?: string;
  role?: string;
  model?: string;
  /** HTTP status of a provider error; null for a network error. */
  statusCode?: number | null;
  /** Number of the model call within one `ModelGateway` call, from 1. */
  attempt?: number;
  /** Class of the call outcome, e.g. `provider_error`. */
  outcome?: string;
  /** Source a warning is about, e.g. one whose snapshot could not be read. */
  sourceId?: string;
  /**
   * Class of the error a warning reports — the constructor name, or the provider's `error.type` of a refused token
   * count; never its message.
   */
  errorClass?: string;
}

/** Logger of the engine, passed by the assembly point. */
export interface EngineLogger {
  log(message: string, fields?: EngineLogFields): void;
  warn(message: string, fields?: EngineLogFields): void;
  error(message: string, fields?: EngineLogFields): void;
}
