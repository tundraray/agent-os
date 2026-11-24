import type { AgentsMcp } from '@agent-os/agents';
import type { ServerFacts } from './library.types';

/** The servers the employee may use, from `AgentsMcp` (ADR-0014): the input of every view and save. */
export async function serverFacts(
  mcp: Pick<AgentsMcp, 'usable'>,
  ownerId: string,
): Promise<ServerFacts> {
  return { usableServers: await mcp.usable(ownerId) };
}
