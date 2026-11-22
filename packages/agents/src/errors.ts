import type { StartRefusedError } from '@agent-os/contracts';

/** Error codes of agents operations (design-agents.md, Error handling; design-runtime.md, Error handling). */
export type AgentsErrorCode =
  /** The agent does not exist or belongs to another owner. */
  | 'AGENT_NOT_FOUND'
  /** The run view: the agent does not exist, belongs to another owner or is not a deep agent (deep-agents KD-2). */
  | 'RUN_NOT_FOUND'
  /** The new agent would be deeper than `AGENT_MAX_DEPTH`. */
  | 'DEPTH_LIMIT'
  /** A restart from scratch of an agent that is still working. */
  | 'NOT_FINISHED'
  /** Edited arguments of a confirmation the tool does not allow, or that fail its schema. */
  | 'INVALID_ARGUMENTS'
  /** The start procedure refused the record: `refusal` names the reason and the model. */
  | 'START_REFUSED';

/**
 * Why a start was refused (409 `START_REFUSED`): `model` is the refused model on a model or provider
 * refusal, otherwise `null` (`model_not_configured`: no default chat model is chosen).
 */
export interface StartRefusalDetail {
  readonly reason: StartRefusedError['reason'];
  readonly model: string | null;
}

/**
 * An expected refusal of an agents operation; the caller maps `code` to its own answer. Codes of
 * runtime (`PARENT_FINISHED`, `PAYLOAD_TOO_LARGE`, `DECISION_NOT_FOUND`) pass through as `RuntimeError`.
 */
export class AgentsError extends Error {
  override readonly name = 'AgentsError';
  /** Set for `START_REFUSED` only. */
  readonly refusal: StartRefusalDetail | null;

  constructor(
    readonly code: AgentsErrorCode,
    message: string,
    options?: ErrorOptions & { readonly refusal?: StartRefusalDetail },
  ) {
    super(message, options);
    this.refusal = options?.refusal ?? null;
  }
}
