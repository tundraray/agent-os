import type { ToolRefusalReason } from '@agent-os/contracts';
import type { z } from 'zod';
import type { ModelChoice } from '../model/model-choice.js';
import { FORK_AGENT, type SessionLimits } from './tool.js';

type Refused<Reason extends ToolRefusalReason> = { readonly kind: 'refused'; readonly reason: Reason };

export interface CallGateInput {
  /** The name the model called. */
  readonly toolName: string;
  /** Names of the tools the session offers: built-in, registered and MCP ones. */
  readonly sessionTools: readonly string[];
  /** The MCP server of the tool; `null` for a built-in or registered tool. */
  readonly serverId: string | null;
  /** `serverAllowed` for the owner and `serverId`, asked by the caller; read only for an MCP tool. */
  readonly ownerAllowed: boolean;
  readonly args: unknown;
  /** Arguments schema of a built-in or registered tool; an MCP server checks its own arguments. */
  readonly argsSchema?: z.ZodType;
}

export type CallGate =
  | { readonly kind: 'allowed'; readonly args: unknown }
  | Refused<'tool_not_in_definition' | 'no_access' | 'invalid_arguments'>;

/**
 * Whether a tool call may run (Flow 1, Failure handling; DC-6): a refused call never reaches the
 * server, and its outcome is `refused` with the reason. Allowed arguments are the parsed ones.
 */
export function gateCall(input: CallGateInput): CallGate {
  if (!input.sessionTools.includes(input.toolName)) {
    return { kind: 'refused', reason: 'tool_not_in_definition' };
  }
  if (input.serverId !== null && !input.ownerAllowed) {
    return { kind: 'refused', reason: 'no_access' };
  }
  if (input.argsSchema === undefined) return { kind: 'allowed', args: input.args };
  const parsed = input.argsSchema.safeParse(input.args);
  return parsed.success
    ? { kind: 'allowed', args: parsed.data }
    : { kind: 'refused', reason: 'invalid_arguments' };
}

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
  /** The child's model by `chooseModel`; for `fork`, the caller's model. */
  readonly model: ModelChoice;
}

export type StartGate =
  | { readonly kind: 'allowed'; readonly model: string }
  | Refused<'not_allowed' | 'depth_limit' | 'unknown_model'>;

/**
 * Whether `start_agent` may start the child (Flow 2, Failure handling; DC-4, AC-10.2, AC-10.3): the
 * agent is in the caller's list and within its count, the child is not deeper than `maxDepth`, and the
 * model has a price. A session started with limits may not fork. A refused start creates no task.
 */
export function gateStart(input: StartGateInput): StartGate {
  if (!startAllowed(input)) return { kind: 'refused', reason: 'not_allowed' };
  if (input.depth + 1 > input.maxDepth) return { kind: 'refused', reason: 'depth_limit' };
  if (input.model.kind === 'refused') return { kind: 'refused', reason: 'unknown_model' };
  return { kind: 'allowed', model: input.model.model };
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

export type TargetGate = { readonly kind: 'allowed' } | Refused<'unknown_agent'>;

/** The target of `message_agent` and `stop_agent` is only a descendant of the caller. */
export function gateTarget(input: { readonly isDescendant: boolean }): TargetGate {
  return input.isDescendant ? { kind: 'allowed' } : { kind: 'refused', reason: 'unknown_agent' };
}
