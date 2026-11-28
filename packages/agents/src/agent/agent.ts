import type { StepContext } from '@agent-os/runtime';

import { agentLines } from '../start/run-definition';
import type { ToolDeclaration } from '../tools/tool';
import { agentOwner } from './agent-owner';
import { BaseAgent } from './base-agent';

/**
 * The ordinary agent, the `agent` task type: runs an agent's version — an agent of the catalogue started by
 * `start_agent`, or a fork — and a team member of a deep agent's version. Everything it does is the shared step
 * of `BaseAgent`; what it may call (`start_agent`, the version's tools and servers) is the data of its version.
 */
export class Agent extends BaseAgent {
  /**
   * The model call's declaration lists whom the agent may start as its owner sees the catalogue now
   * (data-model design-agents.md, KD-6): the agents of its version's `agents` he sees, read on every step, beside
   * the skill catalogue of `BaseAgent`. An agent whose version lists none reads no listing.
   */
  override async offeredDeclaration(
    ctx: StepContext,
  ): Promise<ToolDeclaration> {
    const declaration = await super.offeredDeclaration(ctx);
    const { agents } = this.definition;
    if (agents.length === 0) return declaration;
    const visible = await this.deps.library.listVisible(agentOwner(ctx));
    return { ...declaration, startable: agentLines(agents, visible) };
  }
}
