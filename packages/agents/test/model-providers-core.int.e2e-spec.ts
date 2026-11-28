// model-providers / core - agents-package integration skeleton (in-process `RuntimeModule` + `createAgents` over real Postgres, provider faked on the wire)
// Design Doc: docs/features/model-providers/design-core.md (v1.0), Test Strategy UC-1, UC-2, DC-4; PRD: docs/features/model-providers/prd.md FR-01..FR-04, FR-10.
// Generated: 2026-11-20
// Part: core. THE PART'S BUDGET, THE FULL acProof AND THE LIST OF UNIT TABLES ARE HERE (one place).
//   Budget Used: 7 integration skeletons for the part = 1 here (INT-1) + 6 in apps/api/test/model-providers-core.int.e2e-spec.ts (INT-2 .. INT-7).
//   The owner's cap is 8; the skill's default is 3 (up to 5 when each extra names its defect) - every skeleton has a `Catches:` line.
//   0 E2E: the part has no screen; the journey through the screens is the `web` part's.
// Test Type: Integration. Run with `pnpm --filter @agent-os/agents test:e2e` (`vitest.config.e2e.ts`, `*.e2e-spec.ts`).
//
// Harness (follows agent-platform-agents.int.e2e-spec.ts and test/support/agentsHarness.ts):
//   real Postgres, real `RuntimeModule` and `createAgents`, the REAL `ModelClient` + `createMastraTurnClient` + adapters of the three kinds
//   (not the `AgentTurnModelClient` double: this level exists to prove what is BELOW that seam - the adapter's request and its usage), the
//   provider faked at the network edge by a local HTTP server per kind. The access-gate double of the harness answers the catalogue price.
//   The seam `AgentTurnModelClient` stays the double in apps/api (INT-2 .. INT-7), where the adapters are not under test.
//   HARNESS GAP (support to add by the implementation tasks, not skeletons):
//     - a fake provider server per wire format (Anthropic messages SSE, Gemini `streamGenerateContent` SSE, OpenAI `chat/completions` SSE)
//       that answers a scripted reply with a tool call and usage "10 000 input, 8 000 from cache", records each request's URL, key header and
//       body, and can hold a stream open (the stop row) - built: `test/support/fake-provider.ts`; no fixture tool's schema has `$ref`, `$defs`
//       or `const`, so row B lists `get_trace` of the fixture's `logs` through a proxy that rewrites only its `tools/list` schema;
//     - the harness gets provider rows: `model_providers` inserted through `Agents.providers` (or straight), with `baseUrl` of the fake;
//       the harness has no provider variables any more: providers, keys and addresses are rows (FR-02);
//     - the access-gate double answers a catalogue price per model of the three providers.
//   If a wire fake proves too costly, the fallback is the AI SDK's own mock language models under the adapters: that still proves usage and
//   stop, but NOT the request body (Gemini schema cleaning, DC-4) nor the base URL and key (AC-03.3, AC-01.2); say so in the task if taken.
//   Isolation: a unique runner `newUser()`, unique provider names and model ids per test; the fake servers are closed in `afterAll`.
//
// Proven elsewhere, not repeated here (CLAUDE.md: one test at the lowest level that catches the defect; `provenAt: unit` = a table next to the code):
//   - `classifyRejection` + `ModelClient` rejection rows (packages/agents/src/model/provider-rejection.spec.ts, one table: status/body x reason x
//       ledger row): AC-04.2 (tools rejected, `responseBody` in the log), AC-09.3 (401/403: `provider_key_rejected`, no ledger row),
//       improvements AC-02.1 (408/429/5xx/network: one request, `provider_unavailable`), AC-07.3 (same for embeddings), the per-kind
//       "tools rejected" marker of each adapter (design table "Как разбирается ошибка провайдера").
//   - `providerReadiness` (packages/agents/src/providers/provider-readiness.spec.ts, one table): `ready` / `missing` / `disabled` / `key_missing` per kind.
//   - adapter tables (packages/agents/src/providers/*.spec.ts): default base URL per kind, cache mark only on Anthropic, embedding parameters
//       (`inputType` -> Gemini task type, none for OpenAI-compatible), the connection-check request and `ProviderCheck` mapping (AC-15.1, DC-12:
//       200 / 401 / silence -> `works` / `key_rejected` / `unreachable`, no ledger and no audit row).
//   - `Agents.embeddings` (packages/agents/src/embeddings/embeddings.spec.ts, one table with the `EmbeddingClient` double): AC-07.1 (order, length
//       = dimensions, unit length - DC-8), AC-07.2 (`model_not_configured`, no request), AC-07.4 (`dimension_mismatch`, the batch's ledger row is
//       written), AC-06.3 (a changed default model is the one used), DC-9 (100 per request, empty list = no request), DC-11 (no token count ->
//       estimate, `estimated` in the log).
//   - cost arithmetic of the cache split (AC-10.1, "8 000 at the cache-read price, 2 000 at the input price, none twice") is a unit table of the
//       existing ledger pricing; INT-1 proves only that the real adapters deliver the numbers to it.
//
// `provenAt: not automated`:
//   - AC-04.1 on the real Gemini with the test MCP servers and Sentry (PRD, Assumptions): the owner's manual run; INT-1 proves the cleaned schema
//       in the request body, not that Google accepts it.
//   - AC-17.1 / AC-17.2 (seed on a clean database, no key in the output or the log) and DC-13: the owner's manual seed run.
//   - NFR-02 (first token no later than +50 ms): timing is not asserted in the regular suite; the owner measures it (UC-N1).
//
// acProof (the one proof of every criterion; `unit` = the tables above):
//   AC-01.1 INT-2 · AC-01.2 INT-1 (row D) · AC-01.3 INT-6 · AC-01.4 INT-3 · AC-01.5 INT-2 · AC-02.1 INT-4 · AC-02.2 INT-1 (row A) ·
//   AC-03.1 INT-1 · AC-03.2 INT-1 (stop) · AC-03.3 INT-1 (row C) · AC-04.1 INT-1 (request half) + not automated · AC-04.2 unit ·
//   AC-05.1 unit · AC-05.2 unit · AC-05.3 unit · AC-05.4 INT-1 (row A: an existing `anthropic/...` id) · AC-06.1 INT-7 · AC-06.2 unit ·
//   AC-06.3 unit · AC-07.1 INT-5 (row A, wiring) + unit · AC-07.2 unit · AC-07.3 unit · AC-07.4 unit · AC-07.5 INT-5 (row C) ·
//   AC-08.1 INT-5 (row A) · AC-08.2 INT-5 (row A) · AC-08.3 INT-5 (row B) · AC-09.1 INT-4 · AC-09.2 INT-4 · AC-09.3 unit · AC-09.4 INT-4 ·
//   AC-09.5 unit · AC-10.1 INT-1 + unit · AC-11.1 INT-2 · AC-11.2 INT-2 · AC-15.1 unit · AC-17.1 / AC-17.2 not automated ·
//   NFR-01 INT-2 · NFR-02 not automated.

import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TextDelta } from '@agent-os/agents';
import type { ModelProviderKind } from '@agent-os/contracts';
import { type Database, runtimeModelCalls } from '@agent-os/db';
import { FIXTURE_SHARED_TOKEN, fixtureCallsOf } from '@agent-os/mcp-fixture';
import type { ModelPrice } from '@agent-os/runtime';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerServer, removeServer } from '@agent-os/agents/testing';
import {
  type AgentsHarness,
  createAgentsHarness,
  historyLines,
  historyOf,
  setRootRecord,
  testRecord,
  waitForTaskStatus,
} from './support/agentsHarness';
import {
  FAKE_USAGE,
  type FakeProvider,
  type FakeProviderRequest,
  headersOf,
  readBody,
  startFakeProvider,
} from './support/fake-provider';
import { runName } from './support/mcp-servers';
import { newUser, waitFor } from '@agent-os/db/testing';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The three kinds, in the order of rows A, B, C. */
const KINDS: readonly ModelProviderKind[] = [
  'anthropic',
  'gemini',
  'openai_compatible',
];

/** One provider of the test per kind: its run name (never a real `anthropic` row), model, key and wire facts. */
interface KindRow {
  readonly provider: string;
  readonly model: string;
  /** An obviously fake key of at least 8 characters. */
  readonly key: string;
  /** The key header's value as the kind sends it. */
  readonly sentKey: (key: string) => string;
  /** Path and query of a model turn on the fake. */
  readonly turnPath: string;
}

const ROWS: Readonly<Record<ModelProviderKind, KindRow>> = {
  anthropic: {
    provider: runName('mp-a'),
    model: `${runName('mp-a')}/claude-fake`,
    key: 'mp-fake-anthropic-key-1',
    sentKey: (key) => key,
    turnPath: '/v1/messages',
  },
  gemini: {
    provider: runName('mp-g'),
    model: `${runName('mp-g')}/gemini-fake`,
    key: 'mp-fake-gemini-key-1',
    sentKey: (key) => key,
    turnPath: '/v1beta/models/gemini-fake:streamGenerateContent?alt=sse',
  },
  openai_compatible: {
    provider: runName('mp-l'),
    model: `${runName('mp-l')}/local-fake`,
    key: 'mp-fake-local-key-1',
    sentKey: (key) => `Bearer ${key}`,
    turnPath: '/v1/chat/completions',
  },
};

/** The key row D stores on row A's provider between two calls. */
const REPLACED_KEY = 'mp-fake-anthropic-key-2';

/** The catalogue price of every model of the test: input 1, cache read 0.125, output 5 USD per million tokens. */
const MODEL_PRICE: ModelPrice = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.125,
};

/** One answered call at {@link MODEL_PRICE}: 2 000 x 1 + 8 000 x 0.125 + 20 x 5 = 3 100 micro-USD (AC-10.1). */
const ANSWERED_CALL_COST_USD = 0.0031;

/** The MCP server of the test: the fixture's `logs` behind the schema proxy. */
const SCHEMA_SERVER = runName('mp-schema');
/** `get_trace` of {@link SCHEMA_SERVER} as the model names it, and its arguments. */
const GET_TRACE = `mcp__${SCHEMA_SERVER}__get_trace`;
const TRACE = { traceId: 'c'.repeat(32) };

/**
 * The schema the proxy lists for `get_trace`: every keyword Gemini rejects (DC-4). The fixture's own schemas
 * carry `$schema` and `additionalProperties` but no `$ref`, `$defs` or `const`.
 */
const SCHEMA_WITH_REJECTED_KEYWORDS = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  $defs: { traceId: { type: 'string', pattern: '^[0-9a-f]{32}$' } },
  properties: {
    traceId: { $ref: '#/$defs/traceId' },
    view: { type: 'string', const: 'records' },
  },
  required: ['traceId'],
};
const GEMINI_REJECTED_KEYWORDS = [
  '$schema',
  'additionalProperties',
  '$ref',
  '$defs',
  'const',
];

/**
 * A hard-coded `anthropic/` prefix test (AC-05.4, plan Notes 10). With none on the call path, an id `anthropic/…`
 * that rights and records already carry resolves like any other `<provider>/<name>` (the id row
 * `anthropic/claude-haiku-5-5` of `packages/contracts/src/access.spec.ts`).
 */
const ANTHROPIC_PREFIX_TEST = /['"`]anthropic\/['"`]|ANTHROPIC_PREFIX/;

/** The package's source files (no specs) that test the `anthropic/` prefix. */
function sourcesTestingAnthropicPrefix(): string[] {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .filter((file) =>
      ANTHROPIC_PREFIX_TEST.test(readFileSync(join(root, file), 'utf8')),
    );
}

const ToolsListAnswerSchema = z.looseObject({
  result: z.looseObject({
    tools: z.array(z.looseObject({ name: z.string() })),
  }),
});

/** A `tools/list` answer with `get_trace` listed under {@link SCHEMA_WITH_REJECTED_KEYWORDS}; any other text unchanged. */
function withRejectedKeywords(text: string): string {
  if (!text.startsWith('{')) return text;
  const answer = ToolsListAnswerSchema.safeParse(JSON.parse(text));
  if (!answer.success) return text;
  const tools = answer.data.result.tools.map((tool) =>
    tool.name === 'get_trace'
      ? { ...tool, inputSchema: SCHEMA_WITH_REJECTED_KEYWORDS }
      : tool,
  );
  return JSON.stringify({
    ...answer.data,
    result: { ...answer.data.result, tools },
  });
}

/** Headers a proxy does not pass on: the connection's own and those of a body it may rewrite. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
]);

interface SchemaProxy {
  /** The MCP address to register: the proxy's origin with the fixture's path. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The fixture's MCP server behind a proxy that rewrites only the `tools/list` answer: every request and every other
 * answer passes unchanged, so the tool calls reach the fixture. The fixture answers JSON, never a held stream.
 */
async function startSchemaProxy(target: string): Promise<SchemaProxy> {
  const targetUrl = new URL(target);
  const server = createServer((request, response) => {
    (async () => {
      const body = await readBody(request);
      const headers = Object.entries(headersOf(request)).filter(
        ([name]) => !HOP_HEADERS.has(name),
      );
      const answer = await fetch(
        new URL(request.url ?? '/', targetUrl.origin),
        {
          method: request.method ?? 'GET',
          headers,
          ...(body === '' ? {} : { body }),
        },
      );
      const text = await answer.text();
      answer.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name)) response.setHeader(name, value);
      });
      response.writeHead(answer.status);
      response.end(withRejectedKeywords(text));
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${targetUrl.pathname}`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Every key anywhere in a JSON value. */
function keysIn(value: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        visit(child);
      }
    }
  };
  visit(value);
  return keys;
}

const GeminiRequestSchema = z.looseObject({
  tools: z.array(
    z.looseObject({
      functionDeclarations: z.array(
        z.looseObject({ name: z.string(), parametersJsonSchema: z.unknown() }),
      ),
    }),
  ),
});

/** The token ledger rows of an owner, as the money assertions read them. */
function ledgerOf(db: Database, ownerId: string) {
  return db
    .select({
      callId: runtimeModelCalls.callId,
      model: runtimeModelCalls.model,
      inputTokens: runtimeModelCalls.inputTokens,
      outputTokens: runtimeModelCalls.outputTokens,
      cacheReadTokens: runtimeModelCalls.cacheReadTokens,
      cacheWriteTokens: runtimeModelCalls.cacheWriteTokens,
      costUsd: runtimeModelCalls.costUsd,
    })
    .from(runtimeModelCalls)
    .where(eq(runtimeModelCalls.ownerId, ownerId));
}

/** The ledger row of one answered call of `model`: the fake's usage at the catalogue price. */
function answeredCallRow(model: string) {
  return {
    callId: expect.any(String),
    model,
    inputTokens: FAKE_USAGE.inputTokens,
    outputTokens: FAKE_USAGE.outputTokens,
    cacheReadTokens: FAKE_USAGE.cacheReadTokens,
    cacheWriteTokens: 0,
    costUsd: ANSWERED_CALL_COST_USD,
  };
}

/** The agent every row runs: the same prompt, the schema server, and the row's model. */
function readerRecord(kind: ModelProviderKind) {
  return testRecord('mp-reader', {
    servers: [SCHEMA_SERVER],
    model: ROWS[kind].model,
  });
}

/** A value per kind. */
function byKind<T>(
  value: (kind: ModelProviderKind) => T,
): Record<ModelProviderKind, T> {
  return {
    anthropic: value('anthropic'),
    gemini: value('gemini'),
    openai_compatible: value('openai_compatible'),
  };
}

type FakeProviders = Readonly<Record<ModelProviderKind, FakeProvider>>;
type SentRequests = Readonly<
  Record<ModelProviderKind, readonly FakeProviderRequest[]>
>;

/** Reads, when called, the requests each fake got from now on. */
function requestsFromNow(fakes: FakeProviders): () => SentRequests {
  const start = byKind((kind) => fakes[kind].requests.length);
  return () => byKind((kind) => fakes[kind].requests.slice(start[kind]));
}

/** Whether the key shows anywhere in the request but its key header: the address, another header, the body. */
function keyOutsideItsHeader(
  request: FakeProviderRequest,
  keyHeader: string,
  key: string,
): boolean {
  const otherHeaders = Object.entries(request.headers).flatMap(
    ([name, value]) => (name === keyHeader ? [] : [value]),
  );
  return [request.url, request.bodyText, ...otherHeaders].some((text) =>
    text.includes(key),
  );
}

describe('model-providers / core - agents integration (real Postgres, provider faked on the wire)', () => {
  /** Run in reverse order by `afterAll`, each also when the one before fails. */
  const cleanups: (() => Promise<void>)[] = [];
  /** Every text part of every agent's answer, in arrival order. */
  const textDeltas: TextDelta[] = [];
  let suite:
    | { readonly harness: AgentsHarness; readonly fakes: FakeProviders }
    | undefined;

  function opened(): {
    readonly harness: AgentsHarness;
    readonly fakes: FakeProviders;
  } {
    if (suite === undefined) throw new Error('The INT-1 harness did not start');
    return suite;
  }

  function textPartsOf(agentId: string): string[] {
    return textDeltas
      .filter((delta) => delta.agentId === agentId)
      .map((delta) => delta.text);
  }

  beforeAll(async () => {
    const anthropic = await startFakeProvider('anthropic');
    cleanups.push(() => anthropic.close());
    const gemini = await startFakeProvider('gemini');
    cleanups.push(() => gemini.close());
    const openAICompatible = await startFakeProvider('openai_compatible');
    cleanups.push(() => openAICompatible.close());
    const fakes: FakeProviders = {
      anthropic,
      gemini,
      openai_compatible: openAICompatible,
    };

    const harness = await createAgentsHarness({
      turnClient: 'real',
      access: { '*': [SCHEMA_SERVER] },
      mcpServers: [],
      prices: Object.fromEntries(
        KINDS.map((kind) => [ROWS[kind].model, MODEL_PRICE]),
      ),
      onTextDelta: (delta) => textDeltas.push(delta),
    });
    cleanups.push(() => harness.close());
    const proxy = await startSchemaProxy(
      harness.fixtureProcess.sharedUrl('logs'),
    );
    cleanups.push(() => proxy.close());
    await registerServer(harness.agents, {
      name: SCHEMA_SERVER,
      url: proxy.url,
      mode: 'shared',
      sharedToken: FIXTURE_SHARED_TOKEN,
    });
    cleanups.push(() => removeServer(harness.agents, SCHEMA_SERVER));
    // Providers named for the run, each at its fake's address: never a real `anthropic` row (plan Notes 10).
    for (const kind of KINDS) {
      const row = ROWS[kind];
      await harness.agents.providers.create({
        name: row.provider,
        kind,
        baseUrl: fakes[kind].baseUrl,
        apiKey: row.key,
      });
      cleanups.push(async () => {
        await harness.agents.providers.remove({
          name: row.provider,
          catalogModels: 0,
        });
      });
    }
    suite = { harness, fakes };
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'INT-1 cleanup failed');
  }, TEST_TIMEOUT_MS);

  /**
   * Runs the reader on `kind`'s provider: the fake streams a text in two parts with a `get_trace` call, then, after
   * the tool result, a closing text in two parts. Asserts what rows A-C share — the stream, the tool call returning
   * to the agent, one ledger row per call at the catalogue price, every request on this kind's fake only with the
   * stored key in its header and nowhere else, no key in the log — and returns this kind's requests.
   */
  async function readTraceOn(
    kind: ModelProviderKind,
  ): Promise<readonly FakeProviderRequest[]> {
    const { harness, fakes } = opened();
    const row = ROWS[kind];
    const fake = fakes[kind];
    const ownerId = await newUser();
    const sent = requestsFromNow(fakes);
    const traceCallsBefore = fixtureCallsOf(harness.fixture.callLog, {
      tool: 'get_trace',
      args: TRACE,
    }).length;
    fake.reply({
      kind: 'answer',
      text: ['Reading ', 'the trace'],
      toolCall: { name: GET_TRACE, args: TRACE },
    });
    fake.reply({ kind: 'answer', text: ['The trace ', 'is read'] });
    await setRootRecord(harness.library, readerRecord(kind));

    const { agentId } = await harness.sessions.start({
      ownerId,
      prompt: 'Read the trace',
      description: 'reader',
    });
    await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

    // The answer reached the hook in the parts the provider streamed (AC-03.1)
    expect(textPartsOf(agentId)).toEqual([
      'Reading ',
      'the trace',
      'The trace ',
      'is read',
    ]);
    // The tool call went to the server and its result back to the agent
    expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
      'task: Read the trace',
      `model_answer: Reading the trace [${SCHEMA_SERVER}/get_trace]`,
      'tool_result: get_trace success',
      'model_answer: The trace is read []',
    ]);
    expect(
      fixtureCallsOf(harness.fixture.callLog, {
        tool: 'get_trace',
        args: TRACE,
      }),
    ).toHaveLength(traceCallsBefore + 1);
    // One ledger row per call on the model's id: 10 000 input of which 8 000 cache read, none charged twice (AC-10.1)
    expect(await ledgerOf(harness.db, ownerId)).toEqual([
      answeredCallRow(row.model),
      answeredCallRow(row.model),
    ]);
    // Both requests went to this kind's fake, at the turn path, with the stored key; no other fake got one (AC-03.3)
    const requests = sent();
    const turn = `${row.turnPath} ${row.sentKey(row.key)}`;
    expect(
      byKind((other) =>
        requests[other].map((request) => `${request.url} ${request.key}`),
      ),
    ).toEqual(byKind((other) => (other === kind ? [turn, turn] : [])));
    expect(
      requests[kind].filter((request) =>
        keyOutsideItsHeader(request, fake.keyHeader, row.key),
      ),
    ).toEqual([]);
    expect(JSON.stringify(harness.logs)).not.toContain(row.key);
    return requests[kind];
  }

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: one chat service on three provider kinds - the request, the stream, the usage and the stop
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-03.1 "Given Ане разрешены модели трёх видов, when она поочерёдно запускает одного и того же агента на каждой, then каждый запуск
  //   показывает ответ в беседе по мере генерации, а в журнале затрат по строке на каждый вызов модели с id этой модели";
  //   AC-03.2 "Given агент работает на модели Gemini, when Аня останавливает его, then вызов модели прерывается, и агент останавливается так же,
  //   как на модели Anthropic"; AC-03.3 "Given у OpenAI-совместимого провайдера задан адрес локального сервера, when агент работает на его
  //   модели, then запросы уходят на этот адрес"; AC-10.1 "Given провайдер сообщил, что из 10 000 входных токенов 8 000 прочитаны из кеша, when
  //   платформа считает стоимость вызова, then 8 000 токенов посчитаны по цене чтения кеша, 2 000 — по цене ввода, и ни один токен не посчитан
  //   дважды"; AC-01.2 "Given агент работает на модели провайдера, when администратор заменил ключ, then следующий вызов модели идёт с новым
  //   ключом, а рестарта сервера не было"; AC-02.2 / AC-05.4 (an `anthropic/...` id that rights and records already carry answers without a
  //   restart or an edit); the request half of AC-04.1 (DC-4). Design: UC-1, UC-2, KD-2, KD-3, Flow 1.
  // Behavior: the same agent, started once per provider -> the real `ModelClient` reads the provider row, the adapter of its kind builds the
  //   request -> the fake answers with streamed text, one tool call and usage "10 000 input, 8 000 cache read" -> the tool result goes back to
  //   the agent -> one ledger row per call priced at the catalogue.
  // Rows (one table over the kind; literal expected values):
  //   A. `anthropic` (id `anthropic/...` as already granted): text arrives in parts, the tool call returns to the agent, one ledger row of the model's
  //      id with 10 000 input and 8 000 cache read priced as 2 000 x input + 8 000 x cache-read; the request carries the stored key and the
  //      cache mark; then the same agent is called again after the administrator stored a NEW key (row D below) with no restart.
  //      Plan Notes 10: the provider is `mp-a-<run>` of kind `anthropic`, never the developer's `anthropic` row; the `anthropic/...` id is held
  //      by the id row of `packages/contracts/src/access.spec.ts` and the check that no source of this package tests the `anthropic/` prefix
  //   B. `google` kind Gemini (adapter on its default path replaced by the fake's address): same text, tool call, ledger row; the request body has
  //      none of `$schema`, `additionalProperties`, `$ref`, `$defs` in any tool schema and `const` is sent as `enum` (an MCP tool whose schema
  //      uses all five is the fixture); no cache mark in the body
  //   C. `local` kind OpenAI-compatible with its own `baseUrl`: the request went to that address and to no other; same text, tool call, ledger row
  //   D. key replaced between two calls on row A's provider: the first request carries the first key, the second request the second key, both
  //      answered, no restart, no second instance
  //   E. stop: for each kind the fake holds the stream open, the user stops the run -> the request is aborted, the agent ends stopped like the
  //      Anthropic one, and the aborted attempt is written as an estimate (as today), one row, no second row after the stop
  // Catches: an adapter that drops the cache split from the usage (a cached token charged twice or not at all - money), Gemini receiving the MCP
  //   schema keywords it rejects (the run dies on a tool it should call), the OpenAI-compatible request leaving for the Anthropic address or the
  //   env default instead of the stored `baseUrl`, a key or address cached at start so a replaced key is ignored until restart, and a stop that
  //   works on Anthropic only (the signal not wired into the other two adapters, the stream left running and billed).
  // @category: core-functionality
  // @dependency: ModelClient, createMastraTurnClient, provider adapters (anthropic, gemini, openai-compatible), Agents.providers registry, TokenLedger, runtime stop, Postgres, fake provider servers
  // @complexity: high
  it(
    'INT-1 A: on an `anthropic`-kind provider the reader streams, calls its tool and costs the cache split, the request carries the stored key and the cache mark, and no `anthropic/` prefix test remains',
    async () => {
      const [first] = await readTraceOn('anthropic');

      expect(first?.body).toMatchObject({
        system: expect.arrayContaining([
          expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
        ]),
      });
      // AC-02.2 / AC-05.4: an `anthropic/…` id resolves like any `<provider>/<name>` (plan Notes 10)
      expect(sourcesTestingAnthropicPrefix()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 B: on a `gemini` provider the reader streams, calls its tool and costs the cache split; the tool schemas carry none of the keywords Gemini rejects, `const` goes as `enum`, and no cache mark',
    async () => {
      const [first] = await readTraceOn('gemini');

      // DC-4, the request half of AC-04.1
      const { tools } = GeminiRequestSchema.parse(first?.body);
      expect(
        GEMINI_REJECTED_KEYWORDS.filter((keyword) =>
          keysIn(tools).has(keyword),
        ),
      ).toEqual([]);
      const getTrace = tools
        .flatMap((tool) => tool.functionDeclarations)
        .find((declaration) => declaration.name === GET_TRACE);
      expect(getTrace?.parametersJsonSchema).toMatchObject({
        properties: { view: { enum: ['records'] } },
      });
      expect(
        ['cache_control', 'cachedContent'].filter((keyword) =>
          keysIn(first?.body).has(keyword),
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 C: on an `openai_compatible` provider with its own `baseUrl` the reader streams, calls its tool and costs the cache split, and every request went to that address only',
    async () => {
      // The address row is the shared part of the helper: the fake at the stored `baseUrl` got both turns, the others none
      const requests = await readTraceOn('openai_compatible');

      expect(requests.map((request) => request.url)).toEqual([
        ROWS.openai_compatible.turnPath,
        ROWS.openai_compatible.turnPath,
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 D: a key the administrator replaces between two calls of the same agent goes with the next call, without a restart',
    async () => {
      const { harness, fakes } = opened();
      const row = ROWS.anthropic;
      const ownerId = await newUser();
      const sent = requestsFromNow(fakes);
      fakes.anthropic.reply({ kind: 'answer', text: ['First answer'] });
      fakes.anthropic.reply({ kind: 'answer', text: ['Second answer'] });
      await setRootRecord(harness.library, readerRecord('anthropic'));
      try {
        const { agentId } = await harness.sessions.start({
          ownerId,
          prompt: 'First question',
          description: 'reader',
        });
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

        // When: the administrator stores a new key, and the same agent gets its next message
        await harness.agents.providers.update(row.provider, {
          apiKey: REPLACED_KEY,
        });
        await harness.sessions.send({
          agentId,
          ownerId,
          text: 'Second question',
        });
        const lines = await waitFor(
          async () => historyLines(await historyOf(harness, agentId, ownerId)),
          (history) => history.length === 4,
          'the answer to the second question',
        );

        // Then: both calls answered, the first with the first key, the second with the new one, on one instance
        expect(lines).toEqual([
          'task: First question',
          'model_answer: First answer []',
          'user_message: Second question',
          'model_answer: Second answer []',
        ]);
        expect(sent().anthropic.map((request) => request.key)).toEqual([
          row.key,
          REPLACED_KEY,
        ]);
        expect(JSON.stringify(harness.logs)).not.toContain(REPLACED_KEY);
      } finally {
        await harness.agents.providers.update(row.provider, {
          apiKey: row.key,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.each(KINDS)(
    'INT-1 E (%s): a stop while the provider holds the stream aborts the request, the agent ends stopped, and the cut attempt is one estimated ledger row',
    async (kind) => {
      const { harness, fakes } = opened();
      const row = ROWS[kind];
      const ownerId = await newUser();
      const sent = requestsFromNow(fakes);
      fakes[kind].reply({ kind: 'hold', text: 'Partial ' });
      await setRootRecord(harness.library, readerRecord(kind));

      const { agentId } = await harness.sessions.start({
        ownerId,
        prompt: 'Answer slowly',
        description: 'reader',
      });
      await waitFor(
        () => textPartsOf(agentId),
        (parts) => parts.length === 1,
        'the first part of the held stream',
      );

      // When: the employee stops the run
      expect(await harness.sessions.stop({ agentId, ownerId })).toEqual([
        agentId,
      ]);

      // Then: the provider saw its one request aborted, and the agent ends stopped as on every kind (AC-03.2)
      await waitFor(
        () => sent()[kind],
        (requests) => requests.length === 1 && requests[0]?.aborted === true,
        'the held request to be aborted',
      );
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe(
        'stopped',
      );
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Answer slowly',
        'event: stopped',
      ]);
      // Then: the cut attempt is one row, estimated as today (the streamed 8 bytes are 2 output tokens, none from the
      // cache); the model client logs it right after writing it, and this kind's model has no other cut attempt in the file
      const [logged, ...moreLogged] = await waitFor(
        () =>
          harness.logs.filter(
            (record) =>
              record.message ===
                'unfinished model request recorded with estimated usage' &&
              record.fields.model === row.model,
          ),
        (records) => records.length > 0,
        'the estimated ledger row of the cut attempt',
      );
      expect(moreLogged).toEqual([]);
      expect(logged?.fields).toMatchObject({ estimated: true, aborted: true });
      expect(await ledgerOf(harness.db, ownerId)).toEqual([
        {
          callId: logged?.fields.callId,
          model: row.model,
          inputTokens: expect.any(Number),
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: expect.any(Number),
        },
      ]);
      // Then: no retry and no second row after the stop; no other fake got a request
      expect(byKind((other) => sent()[other].length)).toEqual(
        byKind((other) => (other === kind ? 1 : 0)),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
