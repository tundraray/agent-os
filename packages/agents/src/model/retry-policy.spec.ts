// design-core.md, «Как разбирается ошибка провайдера», Flow 1 Failure handling, KD-2: AC-04.2 (tools not accepted —
// no retry, the provider's body in the log), AC-09.2 and AC-09.4 (a provider that is not ready — no request, no ledger
// row), AC-09.3 (401/403 — no retry, no ledger row), AC-09.5 (408/429/5xx/network — two retries at 1 s and 3 s), the
// «tools not accepted» marker of each kind, DC-10 (no `access_denied` for a provider's refusal: the result is
// `model_error`, never `not_started`), DC-11 (an answer without input tokens is an estimate, `estimated` in the log).
// `classifyRejection` and `ModelClient` are real; the seam, the gate, the registry and the ledger are doubles.
import type { Logger } from '@agent-os/common';
import type { ModelProviderState } from '@agent-os/contracts';
import type { CallUsage, Clock, ModelCallRecord } from '@agent-os/runtime';

import type { AccessDeniedEntry } from '../access-gate';
import { createProviderRegistryDouble } from '../testing';
import type { AgentTurnModelClient } from './mastra-turn';
import { createModelClient } from './model-client';

/** One provider answer of the seam: a rejection in the shape of `AI_APICallError`, or an answer with its usage. */
type SeamAttempt =
  | { readonly status: number | null; readonly body?: string }
  | { readonly usage: CallUsage };

const USAGE: CallUsage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const NO_INPUT_USAGE: CallUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const PRICE = { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cacheReadUsdPerMTok: 0.3, cacheWriteUsdPerMTok: 3.75 };

const PROVIDERS: Readonly<Record<string, ModelProviderState>> = {
  anthropic: 'ready',
  gemini: 'ready',
  openai_compatible: 'ready',
  off: 'disabled',
  keyless: 'key_missing',
};

const ANTHROPIC_TOOLS_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: 'tools.0.custom.input_schema: JSON schema is invalid' },
});
const GEMINI_TOOLS_BODY = JSON.stringify({
  error: {
    code: 400,
    message: "Invalid JSON payload received. Unknown name \"additionalProperties\" at 'tools[0].function_declarations[0].parameters'",
    status: 'INVALID_ARGUMENT',
  },
});
const OPENAI_TOOLS_BODY = JSON.stringify({ error: { message: 'this model does not support tool use', param: 'tools' } });
const OTHER_BAD_REQUEST_BODY = JSON.stringify({ error: { message: 'max_tokens: 99999999 > 64000' } });
const KEY_BODY = JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } });

function apiCallError(status: number | null, body: string | undefined): Error {
  const error = new Error(`provider rejected the request (${status ?? 'network'})`);
  error.name = 'AI_APICallError';
  return Object.assign(error, status === null ? {} : { statusCode: status }, body === undefined ? {} : { responseBody: body });
}

function seamDouble(attempts: readonly SeamAttempt[], calls: { count: number }): AgentTurnModelClient {
  return {
    async streamTurn() {
      const attempt = attempts[calls.count];
      calls.count += 1;
      if (attempt === undefined) throw new Error(`No attempt ${calls.count} in the seam double`);
      if ('status' in attempt) throw apiCallError(attempt.status, attempt.body);
      return { finishReason: 'stop', text: 'ok', toolCalls: [], usage: attempt.usage };
    },
  };
}

function loggerDouble(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return logger;
}

interface Row {
  readonly model: string;
  readonly attempts: readonly SeamAttempt[];
  /** `answer`, or `model_error <reason> <status>`. */
  readonly outcome: string;
  readonly providerCalls: number;
  readonly pauses: readonly number[];
  readonly ledgerRows: number;
  /** The `warn` that names the failure, or the estimate, with the fields it must carry. */
  readonly log: { readonly message: string; readonly fields: Readonly<Record<string, unknown>> } | null;
}

function failed(reason: string, statusCode: number | null, responseBody: string | null, provider = 'anthropic') {
  return { message: 'model call failed', fields: { provider, reason, statusCode, responseBody } };
}

describe('a provider rejection is a named reason with its retries, its ledger rows and its body in the log', () => {
  it.each<[string, Row]>([
    [
      '401: no retry, provider_key_rejected, no ledger row (AC-09.3)',
      {
        model: 'anthropic/claude-turn',
        attempts: [{ status: 401, body: KEY_BODY }],
        outcome: 'model_error provider_key_rejected 401',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 0,
        log: failed('provider_key_rejected', 401, KEY_BODY),
      },
    ],
    [
      '403: no retry, provider_key_rejected (AC-09.3)',
      {
        model: 'gemini/gemini-flash',
        attempts: [{ status: 403, body: KEY_BODY }],
        outcome: 'model_error provider_key_rejected 403',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 0,
        log: failed('provider_key_rejected', 403, KEY_BODY, 'gemini'),
      },
    ],
    [
      'Anthropic 400 about `tools.`: no retry, provider_tools_rejected, the body in the log (AC-04.2)',
      {
        model: 'anthropic/claude-turn',
        attempts: [{ status: 400, body: ANTHROPIC_TOOLS_BODY }],
        outcome: 'model_error provider_tools_rejected 400',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 0,
        log: failed('provider_tools_rejected', 400, ANTHROPIC_TOOLS_BODY),
      },
    ],
    [
      'Gemini 400 naming function_declarations: provider_tools_rejected (AC-04.2)',
      {
        model: 'gemini/gemini-flash',
        attempts: [{ status: 400, body: GEMINI_TOOLS_BODY }],
        outcome: 'model_error provider_tools_rejected 400',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 0,
        log: failed('provider_tools_rejected', 400, GEMINI_TOOLS_BODY, 'gemini'),
      },
    ],
    [
      'OpenAI-compatible 422 about tools: provider_tools_rejected (AC-04.2)',
      {
        model: 'openai_compatible/qwen',
        attempts: [{ status: 422, body: OPENAI_TOOLS_BODY }],
        outcome: 'model_error provider_tools_rejected 422',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 0,
        log: failed('provider_tools_rejected', 422, OPENAI_TOOLS_BODY, 'openai_compatible'),
      },
    ],
    [
      'a 400 not about tools: no retry, model_error',
      {
        model: 'anthropic/claude-turn',
        attempts: [{ status: 400, body: OTHER_BAD_REQUEST_BODY }],
        outcome: 'model_error model_error 400',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 0,
        log: failed('provider_error', 400, OTHER_BAD_REQUEST_BODY),
      },
    ],
    [
      '503 on all three attempts: two retries at 1 s and 3 s, provider_unavailable, no ledger row (AC-09.5)',
      {
        model: 'anthropic/claude-turn',
        attempts: [{ status: 503 }, { status: 503 }, { status: 529, body: 'overloaded' }],
        outcome: 'model_error provider_unavailable 529',
        providerCalls: 3,
        pauses: [1000, 3000],
        ledgerRows: 0,
        log: failed('provider_unavailable', 529, 'overloaded'),
      },
    ],
    [
      '408, then 429, then an answer: retried, one ledger row (AC-09.5)',
      {
        model: 'anthropic/claude-turn',
        attempts: [{ status: 408 }, { status: 429 }, { usage: USAGE }],
        outcome: 'answer',
        providerCalls: 3,
        pauses: [1000, 3000],
        ledgerRows: 1,
        log: failed('provider_unavailable', 429, null),
      },
    ],
    [
      'a network failure without a status on all three attempts: provider_unavailable (AC-09.5)',
      {
        model: 'openai_compatible/qwen',
        attempts: [{ status: null }, { status: null }, { status: null }],
        outcome: 'model_error provider_unavailable null',
        providerCalls: 3,
        pauses: [1000, 3000],
        ledgerRows: 0,
        log: failed('provider_unavailable', null, null, 'openai_compatible'),
      },
    ],
    [
      'a provider that is not registered: no request, provider_missing (AC-09.2)',
      {
        model: 'nowhere/model',
        attempts: [],
        outcome: 'model_error provider_missing null',
        providerCalls: 0,
        pauses: [],
        ledgerRows: 0,
        log: { message: 'model provider not ready', fields: { provider: 'nowhere', reason: 'provider_missing' } },
      },
    ],
    [
      'a disabled provider: no request, provider_disabled (AC-09.2)',
      {
        model: 'off/model',
        attempts: [],
        outcome: 'model_error provider_disabled null',
        providerCalls: 0,
        pauses: [],
        ledgerRows: 0,
        log: { message: 'model provider not ready', fields: { provider: 'off', reason: 'provider_disabled' } },
      },
    ],
    [
      'a provider without its key: no request, provider_key_missing (AC-09.4)',
      {
        model: 'keyless/model',
        attempts: [],
        outcome: 'model_error provider_key_missing null',
        providerCalls: 0,
        pauses: [],
        ledgerRows: 0,
        log: { message: 'model provider not ready', fields: { provider: 'keyless', reason: 'provider_key_missing' } },
      },
    ],
    [
      'an answer without input tokens: one ledger row with an estimate, `estimated` in the log (DC-11)',
      {
        model: 'openai_compatible/qwen',
        attempts: [{ usage: NO_INPUT_USAGE }],
        outcome: 'answer',
        providerCalls: 1,
        pauses: [],
        ledgerRows: 1,
        log: {
          message: 'model answer without input tokens recorded with estimated usage',
          fields: { provider: 'openai_compatible', estimated: true },
        },
      },
    ],
  ])('%s', async (_, row) => {
    const calls = { count: 0 };
    const pauses: number[] = [];
    const ledgerRows: ModelCallRecord[] = [];
    const audits: AccessDeniedEntry[] = [];
    const verdictAsks: string[] = [];
    const logger = loggerDouble();
    const clock: Clock = {
      now: () => new Date(0),
      random: () => 0,
      setTimer: (ms, callback) => {
        pauses.push(ms);
        queueMicrotask(callback);
        return () => {};
      },
    };
    const client = createModelClient({
      turnClient: seamDouble(row.attempts, calls),
      ledger: {
        record: async (call) => {
          ledgerRows.push(call);
          return { callId: 'model-call-1', costUsd: 0 };
        },
      },
      config: { maxOutputTokens: 100 },
      logger,
      access: {
        model: async (_ownerId, model) => {
          verdictAsks.push(model);
          return { kind: 'allowed', price: PRICE };
        },
        defaultChatModel: async () => row.model,
      },
      providers: createProviderRegistryDouble(PROVIDERS),
      audit: async (entry) => {
        audits.push(entry);
      },
      clock,
    });

    const result = await client.call({
      ownerId: 'owner-1',
      rootId: 'root-1',
      taskId: 'agent-1',
      agentName: 'chat',
      model: row.model,
      instructions: 'You are a chat.',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      streamsText: false,
      signal: new AbortController().signal,
      logger,
    });

    const outcome =
      result.kind === 'model_error' ? `model_error ${result.reason} ${result.statusCode}` : result.kind;
    expect(outcome).toBe(row.outcome);
    expect(verdictAsks).toEqual([row.model]);
    expect(calls.count).toBe(row.providerCalls);
    expect(pauses).toEqual(row.pauses);
    expect(ledgerRows).toHaveLength(row.ledgerRows);
    expect(audits).toEqual([]);
    if (row.log !== null) {
      const logged = logger.warn.mock.calls.filter(([message]) => message === row.log?.message);
      expect(logged.at(-1)?.[1]).toMatchObject(row.log.fields);
    }
  });

  it('completeText without a default chat model rejects with model_not_configured before any call (DC-3)', async () => {
    const calls = { count: 0 };
    const client = createModelClient({
      turnClient: seamDouble([{ usage: USAGE }], calls),
      ledger: { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
      config: { maxOutputTokens: 100 },
      logger: loggerDouble(),
      access: {
        model: async () => ({ kind: 'allowed', price: PRICE }),
        defaultChatModel: async () => null,
      },
      providers: createProviderRegistryDouble(PROVIDERS),
      audit: async () => {},
    });

    await expect(
      client.completeText({
        ownerId: 'owner-1',
        system: 'Write a title.',
        prompt: 'Hi',
        maxOutputTokens: 64,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'ModelNotConfiguredError', reason: 'model_not_configured' });
    expect(calls.count).toBe(0);
  });
});
