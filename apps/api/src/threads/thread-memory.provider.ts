import type { Provider } from '@nestjs/common';
import type { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { MASTRA } from '../mastra/mastra.constants.js';

/** Token of the `Memory` instance that stores threads (`mastra_threads` / `mastra_messages`). */
export const THREAD_MEMORY = Symbol('THREAD_MEMORY');

/** Threads are not bound to an agent in storage; this agent's Memory is the access path to them. */
export const THREADS_MEMORY_AGENT_ID = 'assistant';

/** The part of `Mastra` the provider needs; the real `Mastra` instance satisfies it. */
export interface AgentMemorySource {
  getAgent(agentId: typeof THREADS_MEMORY_AGENT_ID): {
    getMemory(): Promise<unknown>;
  };
}

/** Resolves the assistant agent's Memory; anything else fails module initialization (fail fast). */
export async function resolveThreadMemory(
  mastra: AgentMemorySource,
): Promise<Memory> {
  const memory = await mastra.getAgent(THREADS_MEMORY_AGENT_ID).getMemory();
  if (!(memory instanceof Memory)) {
    throw new Error(
      `Agent '${THREADS_MEMORY_AGENT_ID}' must have a @mastra/memory Memory to serve the threads API`,
    );
  }
  return memory;
}

export const threadMemoryProvider: Provider = {
  provide: THREAD_MEMORY,
  inject: [MASTRA],
  useFactory: (mastra: Mastra) => resolveThreadMemory(mastra),
};
