import {
  DeepResearchToolInputSchema,
  type DeepResearchToolResult,
} from '@agent-os/contracts';
import { createTool } from '@mastra/core/tools';
import {
  investigationTokenLimits,
  type ResearchLaunchService,
} from './research-launch.service.js';
import { DEEP_RESEARCH_TOOL, readResearchTurn } from './research-turn.js';

/** The launch service as the tool reaches it: resolved when the tool runs, not when the agent is built. */
export type ResolveLaunches = () => Pick<
  ResearchLaunchService,
  'launch' | 'propose'
>;

/** The tool's input: the contract's, with the budget bounded by the configuration so the model sees the limit. */
const inputSchema = DeepResearchToolInputSchema.extend({
  tokenBudget: DeepResearchToolInputSchema.shape.tokenBudget
    .unwrap()
    .max(investigationTokenLimits().max)
    .optional(),
});

/**
 * The `deepResearch` tool of the chat agent (design-chat-entry.md, KD-1, C3 api). In a research mode turn it starts an
 * investigation, in any other turn it only records a proposal, so the agent never launches one by itself (AC-19.5).
 * The thread and the owner come from the agent's memory, the new launch's `launchKey` is the call's `toolCallId`, and
 * the mode from the turn's `requestContext` — never from the model's arguments. It does not depend on the source mode
 * (KD-8).
 *
 * `launches` is a function so that the agent can be built before the Nest provider of the service exists: the service
 * depends on the threads' memory, which depends on the Mastra instance that holds this agent.
 */
export function createDeepResearchTool(launches: ResolveLaunches) {
  return createTool({
    id: DEEP_RESEARCH_TOOL,
    description:
      'Deep research: a long, multi-step investigation of the question over the connected data sources that ' +
      'answers later in this conversation. Call it with the goal as you understood the question and, when the ' +
      'user named one, the token budget.',
    inputSchema,
    execute: async (input, context): Promise<DeepResearchToolResult> => {
      const { threadId, resourceId, toolCallId } = context.agent ?? {};
      if (!threadId || !resourceId || !toolCallId) {
        throw new Error(
          'deepResearch runs only in a chat turn with a thread and a resource',
        );
      }
      const request = {
        threadId,
        resourceId,
        launchKey: toolCallId,
        goal: input.goal,
        tokenBudget: input.tokenBudget,
      };
      const turn = readResearchTurn(context.requestContext);
      if (turn === null) return { launch: await launches().propose(request) };
      if (turn.kind === 'decision') {
        throw new Error('deepResearch does not apply card decisions');
      }
      return {
        launch: await launches().launch({
          ...request,
          userMessageId: turn.userMessageId,
        }),
      };
    },
  });
}
