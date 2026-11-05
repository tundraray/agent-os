import { RESEARCH_METADATA_KEYS } from '@agent-os/contracts';
import type { AppendMessage } from '@assistant-ui/react';
import {
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type CreateUIMessage,
  type UIMessage,
} from 'ai';

/** The agent tool that launches or proposes a deep research (design-chat-entry.md, KD-1). */
const DEEP_RESEARCH_TOOL = 'deepResearch';

/** What the hiding rule reads of a feed message: assistant-ui keeps message metadata under `custom`. */
export type FeedMessage = {
  readonly role: string;
  readonly metadata: { readonly custom?: Readonly<Record<string, unknown>> | undefined };
};

const hasLabel = (message: FeedMessage, key: string): boolean => message.metadata.custom?.[key] !== undefined;

/**
 * DC-7: the feed does not draw a card decision nor the reply labelled as its decision turn. The reply is known by its
 * label, never by its place after the decision: a research answer may stand right there, and an answer is always drawn.
 */
export function isHiddenMessageAt(messages: readonly FeedMessage[], index: number): boolean {
  const message = messages[index];
  if (message === undefined || hasLabel(message, RESEARCH_METADATA_KEYS.researchAnswer)) return false;
  if (message.role === 'user') return hasLabel(message, RESEARCH_METADATA_KEYS.researchDecision);
  return message.role === 'assistant' && hasLabel(message, RESEARCH_METADATA_KEYS.researchDecisionReply);
}

/** TH-10 (web-shell KD-2): the last message outside a hidden decision pair. */
export function isLastVisibleMessageAt(messages: readonly FeedMessage[], index: number): boolean {
  if (index < 0 || index >= messages.length || isHiddenMessageAt(messages, index)) return false;
  for (let later = index + 1; later < messages.length; later += 1) {
    if (!isHiddenMessageAt(messages, later)) return false;
  }
  return true;
}

/**
 * `sendAutomaticallyWhen`: a turn whose last tool call is `deepResearch` is complete as it is — resending it would start a
 * second agent turn after every launch, proposal or decision (KD-1). Other tool calls resend as before.
 */
export function shouldResendTurn({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages.at(-1);
  const lastCall = last?.role === 'assistant' ? last.parts.filter(isToolUIPart).at(-1) : undefined;
  if (lastCall !== undefined && getToolName(lastCall) === DEEP_RESEARCH_TOOL) return false;
  return lastAssistantMessageIsCompleteWithToolCalls({ messages });
}

const isModeOn = (message: AppendMessage): boolean =>
  message.runConfig?.custom?.[RESEARCH_METADATA_KEYS.deepResearch] === true;

/**
 * `toCreateMessage` of the chat runtime: carries the composer's deep research mode (`runConfig`) into the message
 * metadata as `deepResearch` (KD-1); the server reads it from there and the history keeps it for the DR-02 label.
 * The library's own converter is not exported, so this one covers what the shell's composer sends — text. Any other
 * part fails loudly, as the library's converter does for a part it does not know.
 */
export function toResearchCreateMessage<UI_MESSAGE extends UIMessage = UIMessage>(
  message: AppendMessage,
): CreateUIMessage<UI_MESSAGE> {
  const contents = [...message.content, ...(message.attachments ?? []).flatMap((attachment) => attachment.content)];
  const parts = contents.map((part) => {
    if (part.type !== 'text') throw new Error(`Unsupported part type: ${part.type}`);
    return {
      type: 'text' as const,
      text: part.text,
      ...(part.providerMetadata !== undefined && { providerMetadata: part.providerMetadata }),
    };
  });
  const metadata = isModeOn(message)
    ? { ...message.metadata, [RESEARCH_METADATA_KEYS.deepResearch]: true }
    : message.metadata;
  // `CustomToCreateMessageFunction` is generic over the chat's message type, which a concrete message cannot name.
  return { role: message.role, parts, metadata } as CreateUIMessage<UI_MESSAGE>;
}
