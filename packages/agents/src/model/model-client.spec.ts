// KD-3 (offset), Flow 1 Failure handling (a retry starts the parts again at offset 0), Invariant 4 (a
// `completeText` call is a ledger row without `taskId`), Contract «Расширения нижних пакетов» (a failing
// hook is logged and does not break the step). The port and the ledger are doubles; the clock fires the
// retry pause at once.
import type { Logger } from '@agent-os/common';
import type { Clock, ModelCallRecord, ModelPrice } from '@agent-os/runtime';
import type { AccessDeniedEntry, AccessGate, ModelVerdict } from '../access-gate.js';
import type { AgentTurnModelClient } from './mastra-turn.js';
import { createModelClient, type TextDelta } from './model-client.js';

/** One attempt of the port: its text parts, then the provider status it fails with, if any. */
interface PortAttempt {
  readonly parts: readonly string[];
  readonly failWith?: number;
}

const LEDGER_USAGE = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The price the allowing gate double answers with; the ledger row must carry it unchanged. */
const VERDICT_PRICE: ModelPrice = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  cacheReadUsdPerMTok: 0.3,
  cacheWriteUsdPerMTok: 3.75,
};

/** A gate that allows every model at `VERDICT_PRICE`; the model client asks only about models. */
const ALLOWING_GATE: Pick<AccessGate, 'model'> = {
  model: async () => ({ kind: 'allowed', price: VERDICT_PRICE }),
};

function portDouble(attempts: readonly PortAttempt[]): AgentTurnModelClient {
  let calls = 0;
  return {
    async streamTurn(_call, { onText }) {
      const attempt = attempts[calls];
      calls += 1;
      if (attempt === undefined) throw new Error(`No attempt ${calls} in the port double`);
      for (const part of attempt.parts) onText(part);
      if (attempt.failWith !== undefined) {
        const error = new Error(`provider status ${attempt.failWith}`);
        error.name = 'AI_APICallError';
        throw Object.assign(error, { statusCode: attempt.failWith });
      }
      return { finishReason: 'stop', text: attempt.parts.join(''), toolCalls: [], usage: LEDGER_USAGE };
    },
  };
}

function loggerDouble(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface Row {
  readonly act: 'call' | 'completeText';
  readonly attempts: readonly PortAttempt[];
  readonly hookFails: boolean;
  readonly text: string;
  readonly deltas: readonly Pick<TextDelta, 'offset' | 'text'>[];
  readonly pauses: readonly number[];
  readonly ledgerRow: ModelCallRecord;
  readonly hookWarnings: number;
}

describe('ModelClient streams text parts with running offsets, restarts them on a retry, and survives a failing hook', () => {
  it.each<[string, Row]>([
    [
      'three parts of an answer carry offsets 0, len(p1), len(p1)+len(p2) and give one ledger row',
      {
        act: 'call',
        attempts: [{ parts: ['Hel', 'lo, ', 'world'] }],
        hookFails: false,
        text: 'Hello, world',
        deltas: [
          { offset: 0, text: 'Hel' },
          { offset: 3, text: 'lo, ' },
          { offset: 7, text: 'world' },
        ],
        pauses: [],
        ledgerRow: {
          ownerId: 'owner-1',
          taskId: 'agent-1',
          model: 'anthropic/claude-turn',
          price: VERDICT_PRICE,
          usage: LEDGER_USAGE,
        },
        hookWarnings: 0,
      },
    ],
    [
      'an attempt that streamed a part and failed is retried after the pause from offset 0',
      {
        act: 'call',
        attempts: [{ parts: ['Stale'], failWith: 503 }, { parts: ['Fresh', ' answer'] }],
        hookFails: false,
        text: 'Fresh answer',
        deltas: [
          { offset: 0, text: 'Stale' },
          { offset: 0, text: 'Fresh' },
          { offset: 5, text: ' answer' },
        ],
        pauses: [1000],
        ledgerRow: {
          ownerId: 'owner-1',
          taskId: 'agent-1',
          model: 'anthropic/claude-turn',
          price: VERDICT_PRICE,
          usage: LEDGER_USAGE,
        },
        hookWarnings: 0,
      },
    ],
    [
      'a hook that throws is a warning and the call still answers',
      {
        act: 'call',
        attempts: [{ parts: ['a', 'b'] }],
        hookFails: true,
        text: 'ab',
        deltas: [
          { offset: 0, text: 'a' },
          { offset: 1, text: 'b' },
        ],
        pauses: [],
        ledgerRow: {
          ownerId: 'owner-1',
          taskId: 'agent-1',
          model: 'anthropic/claude-turn',
          price: VERDICT_PRICE,
          usage: LEDGER_USAGE,
        },
        hookWarnings: 2,
      },
    ],
    [
      'completeText writes a ledger row without taskId and gives no parts to the hook',
      {
        act: 'completeText',
        attempts: [{ parts: ['Ti', 'tle'] }],
        hookFails: false,
        text: 'Title',
        deltas: [],
        pauses: [],
        ledgerRow: { ownerId: 'owner-1', model: 'anthropic/claude-default', price: VERDICT_PRICE, usage: LEDGER_USAGE },
        hookWarnings: 0,
      },
    ],
  ])('%s', async (_, row) => {
    const deltas: TextDelta[] = [];
    const ledgerRows: ModelCallRecord[] = [];
    const pauses: number[] = [];
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
      turnClient: portDouble(row.attempts),
      ledger: {
        record: async (call) => {
          ledgerRows.push(call);
          return { callId: 'model-call-1', costUsd: 0 };
        },
      },
      config: { maxOutputTokens: 100, defaultModel: 'anthropic/claude-default' },
      logger,
      access: ALLOWING_GATE,
      audit: async () => {},
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (row.hookFails) throw new Error('notify is down');
      },
      clock,
    });

    const text =
      row.act === 'call'
        ? await client
            .call({
              ownerId: 'owner-1',
              rootId: 'root-1',
              taskId: 'agent-1',
              agentName: 'chat',
              model: 'anthropic/claude-turn',
              instructions: 'You are a chat.',
              messages: [{ role: 'user', content: 'Hi' }],
              tools: [],
              streamsText: true,
              signal: new AbortController().signal,
              logger,
            })
            .then((result) => {
              if (result.kind === 'answer') return result.text;
              return result.kind === 'model_error' ? `model_error ${result.error.statusCode}` : result.kind;
            })
        : await client.completeText({
            ownerId: 'owner-1',
            system: 'Write a title.',
            prompt: 'Hi',
            maxOutputTokens: 64,
            signal: new AbortController().signal,
          });

    expect(text).toBe(row.text);
    expect(deltas.map(({ offset, text: part }) => ({ offset, text: part }))).toEqual(row.deltas);
    for (const delta of deltas) {
      expect(delta).toMatchObject({ ownerId: 'owner-1', rootId: 'root-1', agentId: 'agent-1' });
    }
    expect(pauses).toEqual(row.pauses);
    expect(ledgerRows).toStrictEqual([row.ledgerRow]);
    const hookWarnings = logger.warn.mock.calls.filter(([message]) => message === 'text delta hook failed');
    expect(hookWarnings).toHaveLength(row.hookWarnings);
    for (const [, fields] of hookWarnings) {
      expect(fields).toEqual({ agentId: 'agent-1', error: 'notify is down' });
    }
  });
});

// code-execution AC-01.3, UC-3: the rule of when to write code reaches the model with every agent call.
describe('ModelClient instructions', () => {
  it("every model call's instructions carry the code rule", async () => {
    const sent: string[] = [];
    const logger = loggerDouble();
    const client = createModelClient({
      turnClient: {
        async streamTurn(call) {
          sent.push(call.instructions);
          return { finishReason: 'stop', text: 'ok', toolCalls: [], usage: LEDGER_USAGE };
        },
      },
      ledger: { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
      config: { maxOutputTokens: 100, defaultModel: 'anthropic/claude-default' },
      logger,
      access: ALLOWING_GATE,
      audit: async () => {},
    });

    await client.call({
      ownerId: 'owner-1',
      rootId: 'root-1',
      taskId: 'agent-1',
      agentName: 'chat',
      model: 'anthropic/claude-turn',
      instructions: 'You are a chat.',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      streamsText: false,
      signal: new AbortController().signal,
      logger,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^You are a chat\./);
    expect(sent[0]).toContain('Use run_code when a direct tool result came back cut');
    expect(sent[0]).toContain('count, aggregate or match data');
    expect(sent[0]).toContain('more than three or four tool calls');
    expect(sent[0]).toContain('callTool under the same names as in your tool list (mcp__<server>__<tool>)');
    expect(sent[0]).toContain('to see the message, call that tool directly');
  });
});

interface VerdictRow {
  readonly act: 'call' | 'completeText';
  readonly verdict: ModelVerdict;
  /** Provider attempts; a refused call makes none. */
  readonly attempts: readonly PortAttempt[];
  /** The result kind of `call` (with the refusal reason), or `completeText`'s text or `rejects`. */
  readonly outcome: string;
  readonly providerCalls: number;
  readonly ledgerPrices: readonly ModelPrice[];
  readonly audits: readonly AccessDeniedEntry[];
}

const QUOTA_REFUSAL: ModelVerdict = {
  kind: 'refused',
  reason: 'quota_exhausted',
  spentUsd: 20,
  quotaUsd: 20,
  month: '2026-11',
};

const OTHER_PRICE: ModelPrice = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheReadUsdPerMTok: 0.1,
  cacheWriteUsdPerMTok: 1.25,
};

const REFUSAL_REASONS = [
  'owner_disabled',
  'quota_exhausted',
  'model_not_connected',
  'model_not_allowed',
  'no_models_allowed',
] as const;

function deniedTitle(reason: string): AccessDeniedEntry {
  return {
    kind: 'access_denied',
    actor: 'owner-1',
    objectType: 'model',
    objectId: 'anthropic/claude-default',
    outcome: 'rejected',
    reason,
  };
}

// UC-6, DC-7, KD-3, KD-4.
describe('the model verdict comes before the first attempt: a refusal makes no call, an allowed call is recorded at the verdict\'s price, retries do not ask again, and a refused title calls the audit hook once', () => {
  it.each<[string, VerdictRow]>([
    ...REFUSAL_REASONS.map((reason): [string, VerdictRow] => [
      `a call refused with ${reason} does not start and calls no provider`,
      {
        act: 'call',
        verdict: reason === 'quota_exhausted' ? QUOTA_REFUSAL : { kind: 'refused', reason },
        attempts: [],
        outcome: `not_started ${reason}`,
        providerCalls: 0,
        ledgerPrices: [],
        audits: [],
      },
    ]),
    [
      "an allowed call is recorded at the verdict's price",
      {
        act: 'call',
        verdict: { kind: 'allowed', price: OTHER_PRICE },
        attempts: [{ parts: ['ok'] }],
        outcome: 'answer',
        providerCalls: 1,
        ledgerPrices: [OTHER_PRICE],
        audits: [],
      },
    ],
    [
      'a 529 retry does not ask the gate again',
      {
        act: 'call',
        verdict: { kind: 'allowed', price: VERDICT_PRICE },
        attempts: [{ parts: [], failWith: 529 }, { parts: ['ok'] }],
        outcome: 'answer',
        providerCalls: 2,
        ledgerPrices: [VERDICT_PRICE],
        audits: [],
      },
    ],
    [
      'a title refused for the spent quota rejects and calls the audit hook once',
      {
        act: 'completeText',
        verdict: QUOTA_REFUSAL,
        attempts: [],
        outcome: 'rejects',
        providerCalls: 0,
        ledgerPrices: [],
        audits: [deniedTitle('quota_exhausted')],
      },
    ],
    [
      'a title on a model not allowed rejects and calls the audit hook once',
      {
        act: 'completeText',
        verdict: { kind: 'refused', reason: 'model_not_allowed' },
        attempts: [],
        outcome: 'rejects',
        providerCalls: 0,
        ledgerPrices: [],
        audits: [deniedTitle('model_not_allowed')],
      },
    ],
    [
      'a title of a disabled owner rejects without the audit hook',
      {
        act: 'completeText',
        verdict: { kind: 'refused', reason: 'owner_disabled' },
        attempts: [],
        outcome: 'rejects',
        providerCalls: 0,
        ledgerPrices: [],
        audits: [],
      },
    ],
  ])('%s', async (_, row) => {
    const verdictAsks: string[] = [];
    const ledgerPrices: ModelPrice[] = [];
    const audits: AccessDeniedEntry[] = [];
    let providerCalls = 0;
    const port = portDouble(row.attempts);
    const logger = loggerDouble();
    const client = createModelClient({
      turnClient: {
        streamTurn: (call, options) => {
          providerCalls += 1;
          return port.streamTurn(call, options);
        },
      },
      ledger: {
        record: async (call) => {
          ledgerPrices.push(call.price);
          return { callId: 'model-call-1', costUsd: 0 };
        },
      },
      config: { maxOutputTokens: 100, defaultModel: 'anthropic/claude-default' },
      logger,
      access: {
        model: async (ownerId, model) => {
          verdictAsks.push(`${ownerId} ${model}`);
          return row.verdict;
        },
      },
      audit: async (entry) => {
        audits.push(entry);
      },
      clock: {
        now: () => new Date(0),
        random: () => 0,
        setTimer: (_ms, callback) => {
          queueMicrotask(callback);
          return () => {};
        },
      },
    });

    const outcome =
      row.act === 'call'
        ? await client
            .call({
              ownerId: 'owner-1',
              rootId: 'root-1',
              taskId: 'agent-1',
              agentName: 'chat',
              model: 'anthropic/claude-turn',
              instructions: 'You are a chat.',
              messages: [{ role: 'user', content: 'Hi' }],
              tools: [],
              streamsText: false,
              signal: new AbortController().signal,
              logger,
            })
            .then((result) =>
              result.kind === 'not_started' ? `not_started ${result.verdict.reason}` : result.kind,
            )
        : await client
            .completeText({
              ownerId: 'owner-1',
              system: 'Write a title.',
              prompt: 'Hi',
              maxOutputTokens: 64,
              signal: new AbortController().signal,
            })
            .catch(() => 'rejects');

    expect(outcome).toBe(row.outcome);
    expect(verdictAsks).toEqual([
      row.act === 'call' ? 'owner-1 anthropic/claude-turn' : 'owner-1 anthropic/claude-default',
    ]);
    expect(providerCalls).toBe(row.providerCalls);
    expect(ledgerPrices).toEqual(row.ledgerPrices);
    expect(audits).toEqual(row.audits);
  });
});
