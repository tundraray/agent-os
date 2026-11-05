import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { Memory } from '@mastra/memory';
import { readResearchTurn } from '../../research-chat/research-turn.js';
import {
  type ModelId,
  type ReasoningEffort,
  providerOptionsFor,
  RESEARCH_TURN_MODEL,
} from '../models.js';

/**
 * Instruction of the chat agent. The research rule says when to propose deep research; it does not depend on the
 * connected sources (design-chat-entry.md, KD-1, KD-8).
 */
export const ASSISTANT_INSTRUCTIONS =
  'You are a helpful assistant inside Agent OS. Answer concisely and ask for clarification when a request is ambiguous.\n\n' +
  'Deep research: when answering a question needs a long, multi-step investigation over the connected data ' +
  'sources (logs and similar records) rather than what you already know, call the deepResearch tool with the goal as ' +
  'you understood it; unless the user turned the research mode on, it only proposes the research and the user ' +
  'decides whether to launch it. Do not call it for questions you can answer directly. Write the goal in the language ' +
  "of the user's question.\n\n" +
  'Never show the user internal values of a research or its tool results — source mode, states, ids and keys (for ' +
  'example model_knowledge, proposed or a launchKey); describe them in plain words instead, such as "no data source ' +
  "is connected, so the answer will come from the model's general knowledge\".";

/**
 * The model of a turn (KD-9): `RESEARCH_TURN_MODEL` when the turn's `requestContext` carries the research mode or a
 * card decision, otherwise the chat model.
 */
export function turnModelId(
  chatModel: ModelId,
  requestContext: RequestContext | undefined,
): ModelId {
  return readResearchTurn(requestContext) === null
    ? chatModel
    : RESEARCH_TURN_MODEL;
}

export function createAssistantAgent(
  model: ModelId,
  effort: ReasoningEffort,
  tools: ToolsInput,
) {
  return new Agent({
    id: 'assistant',
    name: 'Assistant',
    instructions: ASSISTANT_INSTRUCTIONS,
    // One agent, memory, instruction and tool set for every turn; only the model follows the turn (KD-9).
    model: ({ requestContext }) => turnModelId(model, requestContext),
    defaultOptions: { providerOptions: providerOptionsFor(effort) },
    // Storage is inherited from the Mastra instance (PostgresStore).
    memory: new Memory({ options: { lastMessages: 20 } }),
    tools,
  });
}
