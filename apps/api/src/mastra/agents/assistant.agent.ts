import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { type ModelId, type ReasoningEffort, providerOptionsFor } from '../models.js';

export function createAssistantAgent(model: ModelId, effort: ReasoningEffort) {
  return new Agent({
    id: 'assistant',
    name: 'Assistant',
    instructions:
      'You are a helpful assistant inside Agent OS. Answer concisely and ask for clarification when a request is ambiguous.',
    model,
    defaultOptions: { providerOptions: providerOptionsFor(effort) },
    // Storage is inherited from the Mastra instance (PostgresStore).
    memory: new Memory({ options: { lastMessages: 20 } }),
    tools: {},
  });
}
