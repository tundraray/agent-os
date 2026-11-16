import type { ToolRefusalReason } from '@agent-os/contracts';
import { FORK_AGENT, type SessionLimits } from './tool.js';

type Refused<Reason extends ToolRefusalReason> = { readonly kind: 'refused'; readonly reason: Reason };

export interface StartGateInput {
  /** The definition name `start_agent` named, or `fork`. */
  readonly agent: string;
  /** `agents` of the caller's definition. */
  readonly definitionAgents: readonly string[];
  /** The caller's session limits; they replace `definitionAgents`. */
  readonly limits: SessionLimits | null;
  /** Successful starts of `agent` by the caller so far. */
  readonly startedCount: number;
  /** The caller's depth (the root's is 0). */
  readonly depth: number;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
}

export type StartGate = { readonly kind: 'allowed' } | Refused<'not_allowed' | 'depth_limit'>;

/**
 * Whether `start_agent` may start the child (Flow 2, Failure handling; DC-4, AC-10.2, AC-10.3): the
 * agent is in the caller's list and within its count, and the child is not deeper than `maxDepth`. A
 * session started with limits may not fork. A refused start creates no task; the model is checked by
 * the access gate after this (design-access.md KD-4).
 */
export function gateStart(input: StartGateInput): StartGate {
  if (!startAllowed(input)) return { kind: 'refused', reason: 'not_allowed' };
  if (input.depth + 1 > input.maxDepth) return { kind: 'refused', reason: 'depth_limit' };
  return { kind: 'allowed' };
}

function startAllowed(input: StartGateInput): boolean {
  if (input.limits !== null) {
    const { agents } = input.limits;
    return (
      input.agent !== FORK_AGENT &&
      Object.hasOwn(agents, input.agent) &&
      input.startedCount < (agents[input.agent] ?? 0)
    );
  }
  return input.agent === FORK_AGENT || input.definitionAgents.includes(input.agent);
}
