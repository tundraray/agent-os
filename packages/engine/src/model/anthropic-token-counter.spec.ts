import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicTokenCounter } from './anthropic-token-counter.js';
import type { TokenCountRequest } from './token-counter.js';

// KD-4: the count goes to the unversioned base from the assembly point — a base with a path keeps
// it, with or without a trailing `/` — with the model without its `anthropic/` prefix and the body
// of the call (role messages and `output_config` with the output JSON schema). A provider 5xx and a
// broken connection come back as a refusal, not as an exception.
// Defects caught: the base path is lost, the model keeps its prefix, the body has no `output_config`.

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: unknown;
}

type Reply = (res: ServerResponse) => void;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { claims: { type: 'array', items: { type: 'string' } } },
  required: ['claims'],
  additionalProperties: false,
};

const REQUEST: TokenCountRequest = {
  model: 'anthropic/claude-haiku-5-5',
  system: 'You analyse log records.',
  messages: [{ role: 'user', content: 'Which service failed first?' }],
  effort: 'low',
  outputSchema: OUTPUT_SCHEMA,
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
  ])('counts at <base>/v1/messages/count_tokens for %s, with the body of the call', async (_case, basePath) => {
    reply = json(200, { input_tokens: 2709 });
    const counter = new AnthropicTokenCounter({ apiKey: 'test-key', baseUrl: `${origin}${basePath}` });

    const result = await counter.countInputTokens(REQUEST, new AbortController().signal);

    expect(result).toEqual({ outcome: 'counted', inputTokens: 2709 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/proxy/v1/messages/count_tokens',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
    });
    expect(seen[0]?.body).toEqual({
      model: 'claude-haiku-5-5',
      system: 'You analyse log records.',
      messages: [{ role: 'user', content: 'Which service failed first?' }],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
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

    await expect(counter.countInputTokens(REQUEST, new AbortController().signal)).resolves.toEqual(expected);
  });
});
