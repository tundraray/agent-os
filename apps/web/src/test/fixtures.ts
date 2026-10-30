import {
  ThreadListResponseSchema,
  ThreadMessagesResponseSchema,
  ThreadSummarySchema,
  type HistoryMessage,
  type ThreadListResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import type { UIMessageChunk } from 'ai';
import { HttpResponse } from 'msw';

const FIXTURE_TIME = '2026-10-28T10:00:00.000Z';

/** A thread as GET /api/threads returns it; validated by ThreadSummarySchema. */
export function threadSummary(overrides: Partial<ThreadSummary> & Pick<ThreadSummary, 'id'>): ThreadSummary {
  return ThreadSummarySchema.parse({
    title: 'Беседа',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** Body of GET /api/threads; validated by ThreadListResponseSchema. */
export function threadList(threads: ThreadSummary[], nextCursor: string | null = null): ThreadListResponse {
  return ThreadListResponseSchema.parse({ threads, nextCursor });
}

export type HistoryTurn = { role: 'user' | 'assistant'; text: string };

/**
 * `messages` of GET /api/threads/:id/messages: AI SDK UIMessages with one text part each.
 * A number builds that many alternating turns ("Сообщение 1" from the user, "Сообщение 2" from the assistant, …).
 */
export function historyMessages(turns: number | readonly HistoryTurn[]): HistoryMessage[] {
  const list: readonly HistoryTurn[] =
    typeof turns === 'number'
      ? Array.from({ length: turns }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: `Сообщение ${index + 1}`,
        }))
      : turns;
  const messages = list.map(({ role, text }, index) => ({
    id: `m${index + 1}`,
    role,
    parts: [{ type: 'text', text }],
  }));
  return ThreadMessagesResponseSchema.parse({ messages }).messages;
}

/** UI message chunks of a complete one-text assistant reply. */
export function assistantTextChunks(text: string, messageId = 'm-reply'): UIMessageChunk[] {
  return [
    { type: 'start', messageId },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
  ];
}

const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
} as const;

/**
 * Response of POST /api/chat/:agentId in the AI SDK v7 UI message stream format (SSE):
 * one `data:` event per chunk, then `data: [DONE]`. A chunk `{ type: 'error', errorText }` ends the reply with a model error.
 */
export function sseFromChunks(chunks: readonly UIMessageChunk[]): HttpResponse<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const events = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new HttpResponse(body, { headers: UI_MESSAGE_STREAM_HEADERS });
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/** A promise settled from the outside: an MSW handler awaits `promise` to hold its response until the test releases it. */
export function deferred<T = void>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}
