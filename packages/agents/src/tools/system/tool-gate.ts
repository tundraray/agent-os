import type { RecordKind, ToolRefusalReason } from '@agent-os/contracts';

type Refused<Reason extends ToolRefusalReason> = {
  readonly kind: 'refused';
  readonly reason: Reason;
  /** What the model reads after the reason (deep-agents KD-4); absent — the reason says it all. */
  readonly text?: string;
};

/** What a `start_agent` call names. */
export type StartTarget =
  | { readonly kind: 'fork' }
  /**
   * A name; `recordKind` — the kind of the agent it starts as the caller's owner sees it: `deep_agent` when
   * the owner sees no agent with the name but a deep agent (data-model design-agents.md, KD-5).
   */
  | { readonly kind: 'name'; readonly recordKind: RecordKind };

export interface StartGateInput {
  readonly target: StartTarget;
  /** The caller's depth (the root's is 0). */
  readonly depth: number;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
}

export type StartGate =
  { readonly kind: 'allowed' } | Refused<'not_allowed' | 'depth_limit'>;

const ALLOWED: StartGate = { kind: 'allowed' };

/** DC-27: a deep agent is started only by `start_deep_agent` of the root, never by `start_agent`. */
const DEEP_AGENT_REFUSAL: StartGate = {
  kind: 'refused',
  reason: 'not_allowed',
  text: 'This name is a deep agent: only the main chat starts a deep agent, with start_deep_agent, after the employee approves its brief.',
};

/**
 * Whether `start_agent` may start the target (data-model design-agents.md, KD-5, rule 1; DC-27;
 * pure-decision.md): any name the caller gives starts its agent or a temporary one — neither the chat's
 * listing nor the caller's `agents` limit it — except a name of a deep agent; a fork always; and the child is
 * not deeper than `maxDepth`. The model is checked after it.
 */
export function gateStart({
  target,
  depth,
  maxDepth,
}: StartGateInput): StartGate {
  if (target.kind === 'name' && target.recordKind === 'deep_agent')
    return DEEP_AGENT_REFUSAL;
  if (depth + 1 > maxDepth) return { kind: 'refused', reason: 'depth_limit' };
  return ALLOWED;
}
