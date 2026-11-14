/** Error codes of agents operations (design-agents.md, Error handling). */
export const AGENTS_ERROR_CODES = [
  /** The agent does not exist or belongs to another owner. */
  'AGENT_NOT_FOUND',
  /** No definition with this name is in the catalog. */
  'UNKNOWN_DEFINITION',
  /** The chosen model has no price in the deployment's prices file. */
  'UNKNOWN_MODEL',
  /** The new agent would be deeper than `AGENT_MAX_DEPTH`. */
  'DEPTH_LIMIT',
  /** A restart from scratch of an agent that is still working. */
  'NOT_FINISHED',
  /** Edited arguments of a confirmation the tool does not allow, or that fail its schema. */
  'INVALID_ARGUMENTS',
] as const;
export type AgentsErrorCode = (typeof AGENTS_ERROR_CODES)[number];

/**
 * An expected refusal of an agents operation; the caller maps `code` to its own answer. Codes of
 * runtime (`PARENT_FINISHED`, `PAYLOAD_TOO_LARGE`, `DECISION_NOT_FOUND`) pass through as `RuntimeError`.
 */
export class AgentsError extends Error {
  override readonly name = 'AgentsError';

  constructor(
    readonly code: AgentsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
