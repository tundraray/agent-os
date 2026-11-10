import {
  StopResearchToolInputSchema,
  type StopResearchToolResult,
} from '@agent-os/contracts';
import { createTool } from '@mastra/core/tools';
import type { ResearchLaunchService } from './research-launch.service.js';

/** Name of the agent's stop tool (design-lifecycle.md, KD-4). */
export const STOP_RESEARCH_TOOL = 'stopResearch';

/** The launch service as the tool reaches it: resolved when the tool runs, as for `deepResearch`. */
type ResolveStops = () => Pick<ResearchLaunchService, 'stopResearch'>;

/**
 * The `stopResearch` tool of the chat agent (design-lifecycle.md, KD-4, Flow 2): the second entry into the one stop
 * operation, from an ordinary turn. The thread and the owner come from the agent's memory, never from the model's
 * arguments; the model only names the `launchKey` of the card it means, and the code checks it in this thread and
 * chooses the target when no key is named. Mode and decision turns offer only `deepResearch` (`activeTools`).
 */
export function createStopResearchTool(stops: ResolveStops) {
  return createTool({
    id: STOP_RESEARCH_TOOL,
    description:
      'Stops a deep research of this conversation that is running. Pass the launchKey of the research the user ' +
      'means, taken from the deepResearch results in this conversation; leave it out when the user did not say ' +
      'which one.',
    inputSchema: StopResearchToolInputSchema,
    execute: async (input, context): Promise<StopResearchToolResult> => {
      const { threadId, resourceId } = context.agent ?? {};
      if (!threadId || !resourceId) {
        throw new Error(
          'stopResearch runs only in a chat turn with a thread and a resource',
        );
      }
      return stops().stopResearch({
        threadId,
        resourceId,
        launchKey: input.launchKey,
      });
    },
  });
}
