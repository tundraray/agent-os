import {
  DeepResearchMetadataSchema,
  RESEARCH_METADATA_KEYS,
  ResearchDecisionSchema,
  type ResearchDecision,
} from '@agent-os/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import {
  type ReasoningEffort,
  researchTurnProviderOptions,
} from '../mastra/models.js';

/** Name of the part's tool on the chat agent (design-chat-entry.md, KD-1). */
export const DEEP_RESEARCH_TOOL = 'deepResearch';

/**
 * Keys of a research turn in the turn's `requestContext`: `ChatController` puts them, the chat agent picks its model
 * by them and the `deepResearch` tool reads them (KD-1, KD-9). The mode and the decision reuse the metadata keys.
 */
const TURN_KEYS = {
  deepResearch: RESEARCH_METADATA_KEYS.deepResearch,
  researchDecision: RESEARCH_METADATA_KEYS.researchDecision,
  userMessageId: 'researchUserMessageId',
} as const;

/** What a research turn carries: the mode or a card decision, and the id of the user message that sent it. */
export type ResearchTurn =
  | { readonly kind: 'mode'; readonly userMessageId: string }
  | {
      readonly kind: 'decision';
      readonly decision: ResearchDecision;
      readonly userMessageId: string;
    };

/** A user message of the request whose metadata turned the research mode on. */
const ModeMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal('user'),
  metadata: z.looseObject({
    [RESEARCH_METADATA_KEYS.deepResearch]: DeepResearchMetadataSchema,
  }),
});

/** The research turn the last message of a chat request asks for, or `null` for an ordinary turn. */
export function researchTurnOf(lastMessage: unknown): ResearchTurn | null {
  const mode = ModeMessageSchema.safeParse(lastMessage);
  return mode.success ? { kind: 'mode', userMessageId: mode.data.id } : null;
}

/** The `requestContext` of a research turn. */
export function researchTurnContext(turn: ResearchTurn): RequestContext {
  const context = new RequestContext();
  context.set(TURN_KEYS.userMessageId, turn.userMessageId);
  if (turn.kind === 'mode') context.set(TURN_KEYS.deepResearch, true);
  else context.set(TURN_KEYS.researchDecision, turn.decision);
  return context;
}

/** The research turn recorded in a turn's `requestContext`, or `null` for an ordinary turn. */
export function readResearchTurn(
  context: RequestContext | undefined,
): ResearchTurn | null {
  if (context === undefined) return null;
  const userMessageId = context.get(TURN_KEYS.userMessageId);
  if (typeof userMessageId !== 'string') return null;
  const decision = ResearchDecisionSchema.safeParse(
    context.get(TURN_KEYS.researchDecision),
  );
  if (decision.success) {
    return { kind: 'decision', decision: decision.data, userMessageId };
  }
  return context.get(TURN_KEYS.deepResearch) === true
    ? { kind: 'mode', userMessageId }
    : null;
}

/**
 * Options of a research turn's `agent.stream` call (KD-1, KD-9): one step, `deepResearch` as the only and forced tool,
 * and the agent's provider options with thinking off and the effort capped at `high`.
 */
export function researchTurnStreamOptions(effort: ReasoningEffort) {
  return {
    maxSteps: 1,
    toolChoice: { type: 'tool', toolName: DEEP_RESEARCH_TOOL } as const,
    activeTools: [DEEP_RESEARCH_TOOL],
    providerOptions: researchTurnProviderOptions(effort),
  };
}
