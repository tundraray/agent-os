import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelProviderKind } from '@agent-os/contracts';

/**
 * A model provider faked at the network edge (model-providers design-core.md, Test Strategy, INT-1): a local HTTP
 * server that speaks one kind's streaming wire format — Anthropic `messages`, Gemini `streamGenerateContent`,
 * OpenAI `chat/completions` — so the real adapters, `ModelClient` and turn client run above it. It answers each
 * request of a model turn with the next reply the test queued, records every request it gets (address, the kind's
 * key header as received, body) and can hold a stream open until the client aborts it.
 */

/** The usage every answer reports: 10 000 input tokens, 8 000 of them read from the cache, 20 output tokens. */
export const FAKE_USAGE = {
  inputTokens: 10_000,
  cacheReadTokens: 8_000,
  outputTokens: 20,
} as const;

export interface FakeToolCall {
  /** The tool's name as the request listed it. */
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * What the fake answers one model request: `answer` streams the text parts in order, then the tool call if any, then
 * the finish with {@link FAKE_USAGE}; `hold` streams one text part and leaves the stream open until the client aborts.
 */
export type FakeReply =
  | {
      readonly kind: 'answer';
      readonly text: readonly string[];
      readonly toolCall?: FakeToolCall;
    }
  | { readonly kind: 'hold'; readonly text: string };

/** One request as the fake got it. */
export interface FakeProviderRequest {
  /** Path and query, as received. */
  readonly url: string;
  /** The value of the kind's key header (`x-api-key`, `x-goog-api-key`, `authorization`), as received. */
  readonly key: string | null;
  /** Every header, names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
  /** The body parsed as JSON; `null` for an empty body. */
  readonly body: unknown;
  /** The client closed the connection before the fake ended the answer. */
  readonly aborted: boolean;
}

export interface FakeProvider {
  /** The provider's address to store as its `baseUrl`, with the kind's version path. */
  readonly baseUrl: string;
  /** The kind's key header, in lower case. */
  readonly keyHeader: string;
  /** Every request so far, in arrival order. */
  readonly requests: readonly FakeProviderRequest[];
  /** Queues the answer of the next model request; a model request with nothing queued gets a 400. */
  reply(reply: FakeReply): void;
  /** Drops every open connection (a held stream too) and stops the server. */
  close(): Promise<void>;
}

/** How one kind's requests and streams look on the wire. */
interface WireFormat {
  /** The version path of the kind's address. */
  readonly basePath: string;
  readonly keyHeader: string;
  /** Whether a `POST` to this path and query is a streamed model request. */
  isTurn(url: string): boolean;
  /** The server-sent events of a reply; for `hold`, only the opening ones. `callId` names the tool call. */
  events(reply: FakeReply, callId: string): string[];
}

/** The text parts a reply streams. */
function textParts(reply: FakeReply): readonly string[] {
  return reply.kind === 'hold' ? [reply.text] : reply.text;
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Anthropic reports the uncached input apart from the cache read. */
function anthropicEvents(reply: FakeReply, callId: string): string[] {
  const event = (data: { readonly type: string } & Record<string, unknown>) =>
    `event: ${data.type}\n${sseData(data)}`;
  const opening = [
    event({
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: FAKE_USAGE.inputTokens - FAKE_USAGE.cacheReadTokens,
          cache_read_input_tokens: FAKE_USAGE.cacheReadTokens,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ...textParts(reply).map((text) =>
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
    ),
  ];
  if (reply.kind === 'hold') return opening;
  const { toolCall } = reply;
  const tool =
    toolCall === undefined
      ? []
      : [
          event({
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: `toolu_${callId}`,
              name: toolCall.name,
              input: {},
            },
          }),
          event({
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(toolCall.args),
            },
          }),
          event({ type: 'content_block_stop', index: 1 }),
        ];
  return [
    ...opening,
    event({ type: 'content_block_stop', index: 0 }),
    ...tool,
    event({
      type: 'message_delta',
      delta: {
        stop_reason: toolCall === undefined ? 'end_turn' : 'tool_use',
        stop_sequence: null,
      },
      usage: { output_tokens: FAKE_USAGE.outputTokens },
    }),
    event({ type: 'message_stop' }),
  ];
}

/** Gemini reports the whole prompt and its cached part. */
function geminiEvents(reply: FakeReply): string[] {
  const candidate = (fields: Record<string, unknown>) =>
    sseData({ candidates: [{ index: 0, ...fields }] });
  const opening = textParts(reply).map((text) =>
    candidate({ content: { role: 'model', parts: [{ text }] } }),
  );
  if (reply.kind === 'hold') return opening;
  const { toolCall } = reply;
  const tool =
    toolCall === undefined
      ? []
      : [
          candidate({
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: toolCall.name, args: toolCall.args } },
              ],
            },
          }),
        ];
  return [
    ...opening,
    ...tool,
    sseData({
      candidates: [{ index: 0, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: FAKE_USAGE.inputTokens,
        cachedContentTokenCount: FAKE_USAGE.cacheReadTokens,
        candidatesTokenCount: FAKE_USAGE.outputTokens,
        totalTokenCount: FAKE_USAGE.inputTokens + FAKE_USAGE.outputTokens,
      },
    }),
  ];
}

/** OpenAI streams the usage in a last chunk without choices (`stream_options.include_usage`). */
function openAIEvents(reply: FakeReply, callId: string): string[] {
  const chunk = (fields: Record<string, unknown>) =>
    sseData({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake',
      ...fields,
    });
  const choice = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ) => chunk({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const opening = textParts(reply).map((text, index) =>
    choice(
      index === 0 ? { role: 'assistant', content: text } : { content: text },
    ),
  );
  if (reply.kind === 'hold') return opening;
  const { toolCall } = reply;
  const tool =
    toolCall === undefined
      ? []
      : [
          choice({
            tool_calls: [
              {
                index: 0,
                id: `call_${callId}`,
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              },
            ],
          }),
        ];
  return [
    ...opening,
    ...tool,
    choice({}, toolCall === undefined ? 'stop' : 'tool_calls'),
    chunk({
      choices: [],
      usage: {
        prompt_tokens: FAKE_USAGE.inputTokens,
        completion_tokens: FAKE_USAGE.outputTokens,
        total_tokens: FAKE_USAGE.inputTokens + FAKE_USAGE.outputTokens,
        prompt_tokens_details: { cached_tokens: FAKE_USAGE.cacheReadTokens },
      },
    }),
    'data: [DONE]\n\n',
  ];
}

const WIRE_FORMATS: Readonly<Record<ModelProviderKind, WireFormat>> = {
  anthropic: {
    basePath: '/v1',
    keyHeader: 'x-api-key',
    isTurn: (url) => url === '/v1/messages',
    events: anthropicEvents,
  },
  gemini: {
    basePath: '/v1beta',
    keyHeader: 'x-goog-api-key',
    isTurn: (url) =>
      url.startsWith('/v1beta/models/') &&
      url.includes(':streamGenerateContent'),
    events: geminiEvents,
  },
  openai_compatible: {
    basePath: '/v1',
    keyHeader: 'authorization',
    isTurn: (url) => url === '/v1/chat/completions',
    events: openAIEvents,
  },
};

/** The whole body of a request as text. */
export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/** The request's headers, each one value (repeated ones joined), names in lower case. */
export function headersOf(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [[name, Array.isArray(value) ? value.join(', ') : value]],
    ),
  );
}

type RecordedRequest = {
  -readonly [Field in keyof FakeProviderRequest]: FakeProviderRequest[Field];
};

/** Starts the fake of `kind` on a free port of 127.0.0.1. */
export async function startFakeProvider(
  kind: ModelProviderKind,
): Promise<FakeProvider> {
  const wire = WIRE_FORMATS[kind];
  const requests: RecordedRequest[] = [];
  const replies: FakeReply[] = [];
  let answered = 0;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const bodyText = await readBody(request);
    const headers = headersOf(request);
    const recorded: RecordedRequest = {
      url: request.url ?? '',
      key: headers[wire.keyHeader] ?? null,
      headers,
      bodyText,
      body: bodyText === '' ? null : JSON.parse(bodyText),
      aborted: false,
    };
    requests.push(recorded);
    response.on('close', () => {
      if (!response.writableEnded) recorded.aborted = true;
    });
    const reply =
      request.method === 'POST' && wire.isTurn(recorded.url)
        ? replies.shift()
        : undefined;
    if (reply === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: `fake ${kind} provider has no reply for ${request.method} ${recorded.url}`,
          },
        }),
      );
      return;
    }
    answered += 1;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    for (const event of wire.events(reply, `fake_${answered}`))
      response.write(event);
    if (reply.kind === 'answer') response.end();
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${wire.basePath}`,
    keyHeader: wire.keyHeader,
    requests,
    reply(reply) {
      replies.push(reply);
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
