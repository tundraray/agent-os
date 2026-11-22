import type { AgentSessions } from './agent-sessions';
import { createControlOperations } from './control-operations';
import type { AgentSessionsDeps } from './operation-support';
import { createStartOperations } from './start-operations';
import { createViewOperations } from './view-operations';

/**
 * The agent operations over the runtime (design-agents.md, Contract «Операции агентов», Security). Each
 * operation calls a runtime operation with `ownerId` first — it checks the owner — and reads `agent_*`
 * only after it, so another owner's agent answers exactly as a missing one (AC-13.3, NFR-06). Every
 * operation is logged with its ids and outcome.
 */
export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions {
  const scoped = { ...deps, logger: deps.logger.child({ service: 'agents.sessions' }) };
  return {
    ...createStartOperations(scoped),
    ...createControlOperations(scoped),
    ...createViewOperations(scoped),
  };
}
