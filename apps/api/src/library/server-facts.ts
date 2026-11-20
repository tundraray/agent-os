import type { Agents } from '@agent-os/agents';
import type { ServerFacts } from './library.service.js';

/** The servers the employee may use, from `Agents.mcp` (ADR-0014): the input of every view and save. */
export async function serverFacts(
  agents: Agents,
  ownerId: string,
): Promise<ServerFacts> {
  return { usableServers: await agents.mcp.usable(ownerId) };
}
