import {
  DeepResearchToolInputSchema,
  DeepResearchToolResultSchema,
  HistoryMessageSchema,
  RESEARCH_METADATA_KEYS,
  ResearchAnswerMetadataSchema,
  ResearchDecisionSchema,
  ResearchLaunchViewSchema,
  ThreadListResponseSchema,
  ThreadMessagesResponseSchema,
  ThreadResearchResponseSchema,
  ThreadSummarySchema,
  type DeepResearchToolResult,
  type HistoryMessage,
  type ResearchAnswerMetadata,
  type ResearchDecision,
  type ResearchLaunchView,
  type ThreadListResponse,
  type ThreadResearchResponse,
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

/** A launch as the card shows it; validated by ResearchLaunchViewSchema. Defaults: an explicit launch that is running. */
export function researchLaunchView(
  overrides: Partial<ResearchLaunchView> & Pick<ResearchLaunchView, 'launchKey'>,
): ResearchLaunchView {
  return ResearchLaunchViewSchema.parse({
    mode: 'explicit',
    state: 'running',
    notLaunchedReason: null,
    goal: 'Почему выросли расходы на облако',
    tokenBudget: 200_000,
    createdAt: FIXTURE_TIME,
    answerMessageId: null,
    answerPending: false,
    sourceMode: 'sources',
    ...overrides,
  });
}

/** Body of GET /api/threads/:id/research; validated by ThreadResearchResponseSchema. */
export function threadResearch(launches: ResearchLaunchView[]): ThreadResearchResponse {
  return ThreadResearchResponseSchema.parse({ launches });
}

export type DeepResearchToolPartInput = {
  toolCallId: string;
  goal: string;
  /** Without a result the part is the call alone (`input-available`), as while the turn still streams. */
  result?: DeepResearchToolResult;
};

/** A `deepResearch` tool part of an assistant message (AI SDK v7 `tool-<name>`), input and result validated by the contracts. */
export function deepResearchToolPart({ toolCallId, goal, result }: DeepResearchToolPartInput): HistoryMessage['parts'][number] {
  const input = DeepResearchToolInputSchema.parse({ goal });
  return result === undefined
    ? { type: 'tool-deepResearch', toolCallId, state: 'input-available', input }
    : {
        type: 'tool-deepResearch',
        toolCallId,
        state: 'output-available',
        input,
        output: DeepResearchToolResultSchema.parse(result),
      };
}

/**
 * The assistant message carrying a research answer under `researchAnswer`. Defaults follow `sourceMode`: from the sources,
 * one established claim citing one source; from the model's knowledge, one assumed claim and no sources (DC-9).
 */
export function researchAnswerMessage({
  id,
  text = 'Ответ ресерча',
  answer,
}: {
  id: string;
  text?: string;
  answer: Partial<ResearchAnswerMetadata> & Pick<ResearchAnswerMetadata, 'launchKey'>;
}): HistoryMessage {
  const claim = 'В октябре добавлены два кластера.';
  const groups =
    answer.sourceMode === 'model_knowledge'
      ? { established: [], assumed: [{ text: claim, footnotes: [], verified: false }], sources: [] }
      : {
          established: [{ text: claim, footnotes: [1], verified: true }],
          assumed: [],
          sources: [{ number: 1, sourceId: 'billing', toolName: 'get_costs', snapshot: 'snap-1', truncated: false }],
        };
  const metadata = ResearchAnswerMetadataSchema.parse({
    goal: 'Почему выросли расходы на облако',
    summary: 'Расходы выросли из-за новых кластеров.',
    outcome: 'answered',
    stopReason: null,
    launch: { messageId: 'm-launch' },
    unknown: [],
    sourceMode: 'sources',
    ...groups,
    ...answer,
  });
  return HistoryMessageSchema.parse({
    id,
    role: 'assistant',
    metadata: { [RESEARCH_METADATA_KEYS.researchAnswer]: metadata },
    parts: [{ type: 'text', text }],
  });
}

/**
 * A card decision as the history stores it: the hidden user message labelled `researchDecision` and the hidden assistant
 * reply labelled `researchDecisionReply`, whose `deepResearch` call returns the launch after the decision.
 */
export function researchDecisionPair({
  idPrefix,
  decision,
  launch,
}: {
  idPrefix: string;
  decision: ResearchDecision;
  launch: ResearchLaunchView;
}): [HistoryMessage, HistoryMessage] {
  const { launchKey } = ResearchDecisionSchema.parse(decision);
  return [
    HistoryMessageSchema.parse({
      id: `${idPrefix}-decision`,
      role: 'user',
      metadata: { [RESEARCH_METADATA_KEYS.researchDecision]: decision },
      parts: [{ type: 'text', text: decision.action }],
    }),
    HistoryMessageSchema.parse({
      id: `${idPrefix}-reply`,
      role: 'assistant',
      metadata: { [RESEARCH_METADATA_KEYS.researchDecisionReply]: { launchKey } },
      parts: [deepResearchToolPart({ toolCallId: `${idPrefix}-call`, goal: launch.goal, result: { launch } })],
    }),
  ];
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
