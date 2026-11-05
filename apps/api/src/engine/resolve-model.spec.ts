import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createResolveModel } from './resolve-model.js';

/** What the local stand-in of the provider saw of one request. */
interface SeenRequest {
  method: string;
  path: string;
  apiKey: string | undefined;
  model: unknown;
}

/** A minimal Anthropic Messages answer, enough for the client to parse it. */
const MESSAGES_ANSWER = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

// KD-7 (S1 of task-03): the role model must call `POST <base>/v1/messages` with the model id without the
// `anthropic/` prefix. Defects this table catches before the real runs of task-22: a `baseURL` without `/v1`, a
// doubled `/v1`, a base that loses its path, or an id sent with its prefix.
describe('createResolveModel - the role model calls Anthropic Messages on <base>/v1', () => {
  let server: Server;
  let origin: string;
  const seen: SeenRequest[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model?: unknown;
        };
        seen.push({
          method: request.method ?? '',
          path: request.url ?? '',
          apiKey: request.headers['x-api-key'] as string | undefined,
          model: body.model,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(MESSAGES_ANSWER));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it.each<[string, string, string, string]>([
    ['anthropic/claude-haiku-5-5', '', '/v1/messages', 'claude-haiku-5-5'],
    ['anthropic/claude-sonnet-5-5', '', '/v1/messages', 'claude-sonnet-5-5'],
    [
      'anthropic/claude-haiku-5-5',
      '/proxy',
      '/proxy/v1/messages',
      'claude-haiku-5-5',
    ],
    [
      'anthropic/claude-sonnet-5-5',
      '/proxy/',
      '/proxy/v1/messages',
      'claude-sonnet-5-5',
    ],
  ])(
    '%s on base path "%s" posts to %s with model %s',
    async (modelId, basePath, expectedPath, expectedModel) => {
      const resolveModel = createResolveModel({
        anthropicBaseUrl: `${origin}${basePath}`,
        anthropicApiKey: 'test-key',
      });

      const model = resolveModel(modelId);
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      });

      expect(seen).toEqual([
        {
          method: 'POST',
          path: expectedPath,
          apiKey: 'test-key',
          model: expectedModel,
        },
      ]);
    },
  );

  it('refuses a model id outside the anthropic provider without a request', () => {
    const resolveModel = createResolveModel({
      anthropicBaseUrl: origin,
      anthropicApiKey: 'test-key',
    });

    expect(() => resolveModel('openai/gpt-5-5')).toThrow(/openai\/gpt-5-5/);
    expect(seen).toEqual([]);
  });
});
