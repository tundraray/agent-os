import { researchAgentToolCalls } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, count, eq, isNotNull, ne } from 'drizzle-orm';
import type { AgentDefinition, AgentProcessConfig } from '../../config/agent-config.schema.js';
import { childShare, freeTokens, turnTokensOf } from '../share-rule.js';

/** The arguments of `call_agent`. */
export interface CallAgentArgs {
  readonly agent: string;
  readonly assignment: string;
}

/** The codes a `call_agent` is refused with before any task (Contract `call_agent`). */
export type CallAgentRefusal = 'agent_not_callable' | 'depth_limit' | 'children_limit' | 'budget_exhausted';

export type CallAgentDecision =
  | { readonly decision: 'refused'; readonly code: CallAgentRefusal }
  | { readonly decision: 'granted'; readonly callee: AgentDefinition; readonly shareTokens: number };

/** What the decision is taken over, read in the call's guarded transaction. */
export interface CallAgentState {
  readonly config: AgentProcessConfig;
  /** The caller's definition and depth (the root's is 0). */
  readonly definition: AgentDefinition;
  readonly depth: number;
  /** Child runs the caller has started: calls with a share that were not refused. */
  readonly childrenStarted: number;
  /** The caller's share and what it occupies of it (KD-4). */
  readonly shareTokens: number;
  readonly occupiedTokens: number;
}

/**
 * Whether a `call_agent` may start a child, in the order of the design's flow «Вызов агента — сколько выдать
 * дочернему»: the callee is among the caller's `calls` (`agent_not_callable`), the child's depth is within `maxDepth`
 * (`depth_limit`), the caller has started fewer than `maxChildren` (`children_limit`), and the caller's free rest holds
 * one turn of the callee (`budget_exhausted`, DC-8). The share is the smaller of the callee's `runTokens` and that rest.
 */
export function decideCallAgent(args: CallAgentArgs, state: CallAgentState): CallAgentDecision {
  const callee = Object.hasOwn(state.config.agents, args.agent) ? state.config.agents[args.agent] : undefined;
  if (callee === undefined || !state.definition.calls.includes(args.agent)) {
    return { decision: 'refused', code: 'agent_not_callable' };
  }
  if (state.depth + 1 > state.config.agentLimits.maxDepth) return { decision: 'refused', code: 'depth_limit' };
  if (state.childrenStarted >= state.definition.limits.maxChildren) return { decision: 'refused', code: 'children_limit' };
  const share = childShare({
    runTokens: callee.limits.runTokens,
    parentFreeTokens: freeTokens({ ceilingTokens: state.shareTokens, occupiedTokens: state.occupiedTokens }),
    childTurnTokens: turnTokensOf(callee.limits),
  });
  if (share.decision === 'refused') return { decision: 'refused', code: share.code };
  return { decision: 'granted', callee, shareTokens: share.shareTokens };
}

/** Child runs a run has started: its calls with a share that were not refused (`limits.maxChildren`, invariant 7). */
export async function childrenStarted(tx: RuntimeTx, runTaskId: string): Promise<number> {
  const [row] = await tx
    .select({ started: count() })
    .from(researchAgentToolCalls)
    .where(
      and(
        eq(researchAgentToolCalls.runTaskId, runTaskId),
        isNotNull(researchAgentToolCalls.shareTokens),
        ne(researchAgentToolCalls.state, 'rejected'),
      ),
    );
  return row?.started ?? 0;
}
