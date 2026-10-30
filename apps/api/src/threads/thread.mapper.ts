import type { StorageThreadType } from '@mastra/core/memory';
import type { HistoryMessage, ThreadSummary } from '@agent-os/contracts';
import { AGENT_ERROR_TEXT } from '../common/stream-error-text.js';

type HistoryMessagePart = HistoryMessage['parts'][number];

const isToolPart = (part: HistoryMessagePart): boolean =>
  part.type.startsWith('tool-') || part.type === 'dynamic-tool';

const isModelErrorPart = (part: HistoryMessagePart): boolean =>
  part.type === 'error';

const maskToolError = (part: HistoryMessagePart): HistoryMessagePart =>
  isToolPart(part) && part.state === 'output-error'
    ? { ...part, errorText: AGENT_ERROR_TEXT }
    : part;

/**
 * The single place where history is freed from raw error text (AC-14.5): the
 * `errorText` of every tool part in `output-error` becomes the text the live
 * stream shows, and model `error` parts (not AI SDK v7 UIMessage parts) are
 * dropped. Other parts and messages are returned unchanged; a message is kept
 * even when no parts remain.
 */
export const maskHistoryErrors = (
  messages: HistoryMessage[],
): HistoryMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts
      .filter((part) => !isModelErrorPart(part))
      .map(maskToolError),
  }));

/** Projects a stored thread to the API shape: no owner or metadata, `''` title → `null`, ISO dates. */
export const toThreadSummary = (thread: StorageThreadType): ThreadSummary => ({
  id: thread.id,
  title: thread.title ? thread.title : null,
  createdAt: thread.createdAt.toISOString(),
  updatedAt: thread.updatedAt.toISOString(),
});
