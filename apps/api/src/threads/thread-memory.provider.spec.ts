import { Memory } from '@mastra/memory';
import {
  THREADS_MEMORY_AGENT_ID,
  resolveThreadMemory,
} from './thread-memory.provider.js';

const fakeMastra = (memory: unknown) => {
  const requestedAgentIds: string[] = [];
  return {
    requestedAgentIds,
    getAgent: (agentId: string) => {
      requestedAgentIds.push(agentId);
      return { getMemory: () => Promise.resolve(memory) };
    },
  };
};

describe('resolveThreadMemory', () => {
  it('reads the memory of the assistant agent', () => {
    expect(THREADS_MEMORY_AGENT_ID).toBe('assistant');
  });

  it('returns the Memory instance of the assistant agent', async () => {
    const memory = new Memory({ options: { lastMessages: 20 } });
    const mastra = fakeMastra(memory);

    await expect(resolveThreadMemory(mastra)).resolves.toBe(memory);
    expect(mastra.requestedAgentIds).toEqual(['assistant']);
  });

  it('fails fast when the agent has no memory', async () => {
    await expect(resolveThreadMemory(fakeMastra(undefined))).rejects.toThrow(
      "Agent 'assistant' must have a @mastra/memory Memory to serve the threads API",
    );
  });

  it('fails fast when the agent memory is not a @mastra/memory Memory', async () => {
    const foreignMemory = { getThreadById: () => Promise.resolve(null) };

    await expect(
      resolveThreadMemory(fakeMastra(foreignMemory)),
    ).rejects.toThrow(
      "Agent 'assistant' must have a @mastra/memory Memory to serve the threads API",
    );
  });
});
