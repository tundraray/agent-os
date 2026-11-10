import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicTokenCounter } from './anthropic-token-counter.js';
import type { AgentTurnCountRequest } from './token-counter.js';

// KD-4: the count goes to the unversioned base from the assembly point — a base with a path keeps
// it, with or without a trailing `/` — with the model without its `anthropic/` prefix and the body
// of the turn. A provider 5xx and a broken connection come back as a refusal, not as an exception.
// Defects caught: the base path is lost, the model keeps its prefix.

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: unknown;
}

type Reply = (res: ServerResponse) => void;

const REQUEST: AgentTurnCountRequest = {
  model: 'anthropic/claude-haiku-5-5',
  system: 'You analyse log records.',
  messages: [{ role: 'user', content: 'Which service failed first?' }],
  tools: [],
  toolChoice: 'auto',
  effort: 'low',
};

let server: Server;
let origin: string;
let seen: SeenRequest[];
let reply: Reply;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

const json = (status: number, body: unknown): Reply => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('AnthropicTokenCounter', () => {
  it.each([
    ['a base with a path, no trailing slash', '/proxy'],
    ['a base with a path and a trailing slash', '/proxy/'],
  ])('counts at <base>/v1/messages/count_tokens for %s, with the model without its prefix', async (_case, basePath) => {
    reply = json(200, { input_tokens: 2709 });
    const counter = new AnthropicTokenCounter({ apiKey: 'test-key', baseUrl: `${origin}${basePath}` });

    const result = await counter.countTurnInputTokens(REQUEST, new AbortController().signal);

    expect(result).toEqual({ outcome: 'counted', inputTokens: 2709 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/proxy/v1/messages/count_tokens',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
    });
    expect(seen[0]?.body).toMatchObject({ model: 'claude-haiku-5-5', system: 'You analyse log records.' });
  });

  // DC-30, plan Notes 1.10: the counted input of an agent turn is the whole input of the turn — its tool schemas go as
  // `tools`, its calls and results as `tool_use` and `tool_result` blocks; consecutive user messages go as one, as the
  // turn sends them.
  // Defects caught: a turn counted without its tool schemas or tool blocks, which understates the input.
  it('counts an agent turn with its tools as tools and its calls and results as tool_use and tool_result blocks', async () => {
    reply = json(200, { input_tokens: 4321 });
    const counter = new AnthropicTokenCounter({ apiKey: 'test-key', baseUrl: origin });
    const schema = { type: 'object', properties: { after: { type: 'integer' } }, additionalProperties: false };

    const result = await counter.countTurnInputTokens(
      {
        model: 'anthropic/claude-haiku-5-5',
        system: 'You look for the cause.',
        messages: [
          { role: 'user', content: 'Find why the job fails.' },
          { role: 'assistant', content: 'reading notes', toolCalls: [{ toolCallId: 'tc-1', toolName: 'memory_read', args: { after: 0 } }] },
          { role: 'tool', results: [{ toolCallId: 'tc-1', toolName: 'memory_read', output: { notes: [] } }] },
          { role: 'user', content: 'last turn: return the result' },
        ],
        tools: [{ name: 'memory_read', description: 'Reads notes', inputSchema: schema }],
        toolChoice: { toolName: 'finish' },
        effort: 'low',
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ outcome: 'counted', inputTokens: 4321 });
    expect(seen[0]?.url).toBe('/v1/messages/count_tokens');
    expect(seen[0]?.body).toEqual({
      model: 'claude-haiku-5-5',
      system: 'You look for the cause.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find why the job fails.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading notes' },
            { type: 'tool_use', id: 'tc-1', name: 'memory_read', input: { after: 0 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc-1', content: '{"notes":[]}' },
            { type: 'text', text: 'last turn: return the result' },
          ],
        },
      ],
      tools: [{ name: 'memory_read', description: 'Reads notes', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'finish' },
      output_config: { effort: 'low' },
    });
  });

  // The refusal carries the provider's error class for the log, never its message (T7.3: a 400 on the output schema
  // was invisible). Defect caught: the class is lost, or the message, which may quote the request, is passed on.
  it.each<[string, Reply, { outcome: 'failed'; statusCode: number | null; errorClass: string }]>([
    [
      'a provider 5xx',
      json(529, { type: 'error', error: { type: 'overloaded_error' } }),
      { outcome: 'failed', statusCode: 529, errorClass: 'overloaded_error' },
    ],
    [
      'a provider 400 with a message',
      json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format.schema: secret' } }),
      { outcome: 'failed', statusCode: 400, errorClass: 'invalid_request_error' },
    ],
    ['a provider error without a JSON body', (res) => res.writeHead(502).end('bad gateway'), { outcome: 'failed', statusCode: 502, errorClass: 'http_error' }],
    ['a broken connection', (res) => res.socket?.destroy(), { outcome: 'failed', statusCode: null, errorClass: 'network_error' }],
  ])('returns a refusal, not an exception, on %s', async (_case, failure, expected) => {
    reply = failure;
    const counter = new AnthropicTokenCounter({ apiKey: 'test-key', baseUrl: origin });

    await expect(counter.countTurnInputTokens(REQUEST, new AbortController().signal)).resolves.toEqual(expected);
  });
});
