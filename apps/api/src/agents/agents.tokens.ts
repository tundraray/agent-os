/** Providers of `AgentsModule`, the composition root of the agents package in `apps/api` (design-agents.md, C2 `api`). */

/**
 * The assembled agents package (`Agents` of `@agent-os/agents`). Upper modules register their definitions
 * and tools on it in their providers' factories, before `AgentsModule.onModuleInit` calls `start()`.
 */
export const AGENTS = Symbol('AGENTS');

/** Agents settings (`AgentsConfig`) read from the environment and the servers file by `readAgentsSettings`. */
export const AGENTS_SETTINGS = Symbol('AGENTS_SETTINGS');

/**
 * The model seam (`AgentTurnModelClient`): Mastra on Anthropic in production; the tests' `createTestApp`
 * replaces this one token with the scripted double of `@agent-os/agents/testing`.
 */
export const AGENT_TURN_CLIENT = Symbol('AGENT_TURN_CLIENT');

/** The `DeltaPublisher`: the `onTextDelta` hook publishing agents' text parts to NOTIFY. */
export const DELTA_PUBLISHER = Symbol('DELTA_PUBLISHER');
