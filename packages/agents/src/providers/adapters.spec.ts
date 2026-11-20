import type { ModelProviderCheck, ModelProviderKind } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';

import { type EmbeddingInputType, type ProviderOptions, providerAdapter } from './adapters.js';
import { type CheckFetch, checkProvider } from './provider-check.js';
import { PROVIDER_KINDS } from './provider-kinds.js';
import type { ProviderConnection } from './provider-registry.js';

// design-core.md KD-3, «Как разбирается ошибка провайдера», FR-15 / AC-15.1, DC-12: one row per kind — the
// default address the requests go to, the AI SDK provider of the model (a `google` one is what makes Mastra
// clean Gemini's tool schemas), the cache mark only on Anthropic, the embedding options per `inputType` (Gemini
// also asks for the catalogue's dimensions — its default 3072 would not match), the «tools not accepted» marker
// on a recorded error body of the kind, and the check: 200 / 401 / silence → `works` / `key_rejected` /
// `unreachable`. The network is the only stub; the adapters are real.
const KEY = 'fake-key-0000';
const DIMENSIONS = 768;
const SHORT_TIMEOUT_MS = 20;

interface KindRow {
  readonly kind: ModelProviderKind;
  readonly checkUrl: string;
  readonly keyHeader: Readonly<Record<string, string>>;
  readonly modelProvider: string;
  readonly cacheMark: ProviderOptions | null;
  readonly embeddingOptions: Readonly<Record<EmbeddingInputType, ProviderOptions | undefined>> | null;
  readonly toolsBody: string;
  readonly otherBody: string;
}

const ROWS: readonly KindRow[] = [
  {
    kind: 'anthropic',
    checkUrl: 'https://api.anthropic.com/v1/models',
    keyHeader: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    modelProvider: 'anthropic.messages',
    cacheMark: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    embeddingOptions: null,
    toolsBody:
      '{"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom.input_schema: JSON schema is invalid"}}',
    otherBody: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}',
  },
  {
    kind: 'gemini',
    checkUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    keyHeader: { 'x-goog-api-key': KEY },
    modelProvider: 'google.generative-ai',
    cacheMark: null,
    embeddingOptions: {
      document: { google: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: DIMENSIONS } },
      query: { google: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: DIMENSIONS } },
    },
    toolsBody:
      '{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"additionalProperties\\" at \'tools[0].function_declarations[0].parameters\': Cannot find field.","status":"INVALID_ARGUMENT"}}',
    otherBody: '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}',
  },
  {
    kind: 'openai_compatible',
    checkUrl: 'https://api.openai.com/v1/models',
    keyHeader: { authorization: `Bearer ${KEY}` },
    modelProvider: 'local.chat',
    cacheMark: null,
    embeddingOptions: { document: undefined, query: undefined },
    toolsBody:
      '{"error":{"message":"Invalid schema for function \'search\'.","type":"invalid_request_error","param":"tools[0].function.parameters","code":"invalid_function_parameters"}}',
    otherBody:
      '{"error":{"message":"Invalid value for \'temperature\'.","type":"invalid_request_error","param":"temperature","code":null}}',
  },
];

interface SentRequest {
  readonly url: string;
  readonly headers: unknown;
}

/** A provider that answers every request with `status` and `body`, recording what it was sent. */
function answering(status: number, body: string, sent: SentRequest[]): CheckFetch {
  return async (url, init) => {
    sent.push({ url, headers: init.headers });
    return new Response(body, { status });
  };
}

/** A provider that never answers: the request ends only by its own timeout. */
const silent: CheckFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

describe('provider adapters', () => {
  it.each(ROWS)('$kind', async (row) => {
    const adapter = providerAdapter(row.kind);
    const connection: ProviderConnection = {
      name: 'local',
      kind: row.kind,
      baseUrl: PROVIDER_KINDS[row.kind].defaultBaseUrl,
      apiKey: KEY,
      enabled: true,
    };

    expect(adapter.languageModel(connection, 'some-model').provider).toBe(row.modelProvider);
    expect(adapter.cacheMark).toEqual(row.cacheMark);
    expect(
      adapter.embeddings === null
        ? null
        : {
            document: adapter.embeddings.providerOptions('document', DIMENSIONS),
            query: adapter.embeddings.providerOptions('query', DIMENSIONS),
          },
    ).toEqual(row.embeddingOptions);

    expect(adapter.toolsRejected(400, row.toolsBody)).toBe(true);
    expect(adapter.toolsRejected(422, row.toolsBody)).toBe(true);
    expect(adapter.toolsRejected(500, row.toolsBody)).toBe(false);
    expect(adapter.toolsRejected(400, row.otherBody)).toBe(false);
    expect(adapter.toolsRejected(400, 'Bad Request')).toBe(false);

    const sent: SentRequest[] = [];
    const works: ModelProviderCheck = { result: 'works', message: null };
    await expect(checkProvider(connection, { fetch: answering(200, '{"data":[]}', sent) })).resolves.toEqual(works);
    expect(sent).toEqual([{ url: row.checkUrl, headers: row.keyHeader }]);

    const keyRejected: ModelProviderCheck = { result: 'key_rejected', message: '401 invalid key' };
    await expect(checkProvider(connection, { fetch: answering(401, 'invalid key', []) })).resolves.toEqual(keyRejected);

    const unanswered = await checkProvider(connection, { fetch: silent, timeoutMs: SHORT_TIMEOUT_MS });
    expect(unanswered.result).toBe('unreachable');
    expect(unanswered.message).not.toBeNull();
  });
});
