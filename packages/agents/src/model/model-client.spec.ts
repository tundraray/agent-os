// KD-3 (offset), Flow 1 Failure handling (a failure after the answer began ends the call), Invariant 4 (a
// `completeText` call is a ledger row without `taskId`), Contract «Расширения нижних пакетов» (a failing
// hook is logged and does not break the step); an answered request is one ledger row, a request cut by a
// cancel or failed after its answer began is one with an estimate from UTF-8 bytes. The port, the gate, the
// provider registry and the ledger are doubles.
import type { Logger } from '@agent-os/common';
import {
  type Clock,
  type ModelCallRecord,
  type ModelPrice,
  systemClock,
} from '@agent-os/runtime';
import type {
  AccessDeniedEntry,
  AccessGate,
  AuditRecord,
  ModelVerdict,
} from '../access-gate';
import type { AgentTurnCall, AgentTurnModelClient } from './mastra-turn';
import { createProviderRegistryDouble } from '../testing';
import { CODE_RULE, ModelClient, type TextDelta } from './model-client';
import { DATA_PREAMBLE } from './provider-messages';

/** One attempt of the port: its text parts, then the provider status it fails with or the cancel that cuts it, if any. */
interface PortAttempt {
  readonly parts: readonly string[];
  readonly failWith?: number;
  readonly cancelled?: true;
}

const LEDGER_USAGE = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** The price the allowing gate double answers with; the ledger row must carry it unchanged. */
const VERDICT_PRICE: ModelPrice = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  cacheReadUsdPerMTok: 0.3,
  cacheWriteUsdPerMTok: 3.75,
};

/** A gate that allows every model at `VERDICT_PRICE`, with `anthropic/claude-default` as the default chat model. */
const ALLOWING_GATE: Pick<AccessGate, 'model' | 'defaultChatModel'> = {
  model: async () => ({ kind: 'allowed', price: VERDICT_PRICE }),
  defaultChatModel: async () => 'anthropic/claude-default',
};

/** The provider of every model of these tests, ready. */
const READY_PROVIDERS = createProviderRegistryDouble({ anthropic: 'ready' });

/** `cancel` aborts the call's signal: a `cancelled` attempt calls it after its parts and rejects as the port does. */
function portDouble(
  attempts: readonly PortAttempt[],
  cancel: () => void = () => {},
): AgentTurnModelClient {
  let calls = 0;
  return {
    async streamTurn(_call, { onText, signal }) {
      const attempt = attempts[calls];
      calls += 1;
      if (attempt === undefined)
        throw new Error(`No attempt ${calls} in the port double`);
      for (const part of attempt.parts) onText(part);
      if (attempt.cancelled) {
        cancel();
        signal.throwIfAborted();
      }
      if (attempt.failWith !== undefined) {
        const error = new Error(`provider status ${attempt.failWith}`);
        error.name = 'AI_APICallError';
        throw Object.assign(error, { statusCode: attempt.failWith });
      }
      return {
        finishReason: 'stop',
        text: attempt.parts.join(''),
        toolCalls: [],
        usage: LEDGER_USAGE,
      };
    },
  };
}

type ModelClientArgs = ConstructorParameters<typeof ModelClient>;

/** `ModelClient` from named doubles; the real clock unless a test gives its own. */
function createModelClient(deps: {
  turnClient: ModelClientArgs[0];
  ledger: ModelClientArgs[1];
  config: ModelClientArgs[2];
  logger: ModelClientArgs[3];
  access: ModelClientArgs[4];
  providers: ModelClientArgs[5];
  audit: ModelClientArgs[6];
  clock?: Clock;
  onTextDelta?: ModelClientArgs[9];
}): ModelClient {
  return new ModelClient(
    deps.turnClient,
    deps.ledger,
    deps.config,
    deps.logger,
    deps.access,
    deps.providers,
    deps.audit,
    deps.clock ?? systemClock,
    { check: async () => 'allowed' as const },
    deps.onTextDelta,
  );
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
  readonly ledgerRows: readonly ModelCallRecord[];
  readonly hookWarnings: number;
}

const TURN_ROW = {
  ownerId: 'owner-1',
  taskId: 'agent-1',
  model: 'anthropic/claude-turn',
  price: VERDICT_PRICE,
};

describe('ModelClient streams text parts with running offsets, records a failed answer by its estimate, and survives a failing hook', () => {
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
        ledgerRows: [{ ...TURN_ROW, usage: LEDGER_USAGE }],
        hookWarnings: 0,
      },
    ],
    [
      'a part streamed, then a failure — model_error and one ledger row by the estimate (improvements AC-02.1)',
      {
        act: 'call',
        attempts: [
          { parts: ['Старт'], failWith: 503 },
          { parts: ['Fresh', ' answer'] },
        ],
        hookFails: false,
        text: 'model_error 503',
        deltas: [{ offset: 0, text: 'Старт' }],
        // The request failed after its answer began, so it is a row: the request as input (an estimate),
        // the 5 streamed Cyrillic characters as 10 bytes — 3 tokens, not the 2 of a character count.
        ledgerRows: [
          {
            ...TURN_ROW,
            usage: {
              inputTokens: expect.any(Number),
              outputTokens: 3,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        ],
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
        ledgerRows: [{ ...TURN_ROW, usage: LEDGER_USAGE }],
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
        ledgerRows: [
          {
            ownerId: 'owner-1',
            model: 'anthropic/claude-default',
            price: VERDICT_PRICE,
            usage: LEDGER_USAGE,
          },
        ],
        hookWarnings: 0,
      },
    ],
  ])('%s', async (_, row) => {
    const deltas: TextDelta[] = [];
    const ledgerRows: ModelCallRecord[] = [];
    const logger = loggerDouble();
    const clock: Clock = {
      now: () => new Date(0),
      setTimer: () => {
        throw new Error('ModelClient sets no timer');
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
      config: { maxOutputTokens: 100 },
      providers: READY_PROVIDERS,
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
              training: false,
              signal: new AbortController().signal,
              logger,
            })
            .then((result) => {
              if (result.kind === 'answer') return result.text;
              return result.kind === 'model_error'
                ? `model_error ${result.statusCode}`
                : result.kind;
            })
        : await client.completeText({
            ownerId: 'owner-1',
            system: 'Write a title.',
            prompt: 'Hi',
            maxOutputTokens: 64,
            signal: new AbortController().signal,
          });

    expect(text).toBe(row.text);
    expect(
      deltas.map(({ offset, text: part }) => ({ offset, text: part })),
    ).toEqual(row.deltas);
    for (const delta of deltas) {
      expect(delta).toMatchObject({
        ownerId: 'owner-1',
        rootId: 'root-1',
        agentId: 'agent-1',
      });
    }
    expect(ledgerRows).toStrictEqual(row.ledgerRows);
    const hookWarnings = logger.warn.mock.calls.filter(
      ([message]) => message === 'text delta hook failed',
    );
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
          return {
            finishReason: 'stop',
            text: 'ok',
            toolCalls: [],
            usage: LEDGER_USAGE,
          };
        },
      },
      ledger: { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
      config: { maxOutputTokens: 100 },
      providers: READY_PROVIDERS,
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
      training: false,
      signal: new AbortController().signal,
      logger,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(`You are a chat.\n\n${DATA_PREAMBLE}\n\n${CODE_RULE}`);
    // The rule names the tools a stored result is read with, as the wrapper and their descriptions do.
    for (const name of [
      'read_tool_result',
      'search_tool_result',
      'run_code',
      'readResult',
    ]) {
      expect(CODE_RULE).toContain(name);
    }
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
  /**
   * The ledger rows: the price and the usage — the provider's (`LEDGER_USAGE`), or for an unfinished attempt
   * the output tokens of its estimate; the input tokens of an estimate are counted from the sent request.
   */
  readonly ledgerRows: readonly {
    readonly price: ModelPrice;
    readonly estimatedOutputTokens?: number;
  }[];
  readonly audits: readonly AuditRecord[];
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

// UC-6, DC-7, KD-3, KD-4. Provider rejections and their ledger rows: provider-rejection.spec.ts.
describe("the model verdict comes before the request: a refusal makes no call, every billed request is recorded at the verdict's price, and a refused title calls the audit hook once", () => {
  it.each<[string, VerdictRow]>([
    [
      'a refused call does not start: no provider call and no ledger row',
      {
        act: 'call',
        verdict: QUOTA_REFUSAL,
        attempts: [],
        outcome: 'not_started quota_exhausted',
        providerCalls: 0,
        ledgerRows: [],
        audits: [],
      },
    ],
    [
      "a call cancelled in the middle of its answer rejects and leaves exactly one ledger row at the verdict's price, estimated from UTF-8 bytes",
      {
        act: 'call',
        verdict: { kind: 'allowed', price: OTHER_PRICE },
        // 12 characters, 23 bytes: 6 tokens, where a character count would give 3.
        attempts: [{ parts: ['половина', ' отв'], cancelled: true }],
        outcome: 'rejects',
        providerCalls: 1,
        ledgerRows: [{ price: OTHER_PRICE, estimatedOutputTokens: 6 }],
        audits: [],
      },
    ],
    [
      "an allowed call is recorded at the verdict's price",
      {
        act: 'call',
        verdict: { kind: 'allowed', price: OTHER_PRICE },
        attempts: [{ parts: ['ok'] }],
        outcome: 'answer',
        providerCalls: 1,
        ledgerRows: [{ price: OTHER_PRICE }],
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
        ledgerRows: [],
        audits: [deniedTitle('quota_exhausted')],
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
        ledgerRows: [],
        audits: [],
      },
    ],
  ])('%s', async (_, row) => {
    const verdictAsks: string[] = [];
    const ledgerRows: ModelCallRecord[] = [];
    let sent: AgentTurnCall | undefined;
    const audits: AuditRecord[] = [];
    let providerCalls = 0;
    const cancel = new AbortController();
    const port = portDouble(row.attempts, () =>
      cancel.abort(new Error('the step was cancelled')),
    );
    const logger = loggerDouble();
    const client = createModelClient({
      turnClient: {
        streamTurn: (call, options) => {
          providerCalls += 1;
          sent = call;
          return port.streamTurn(call, options);
        },
      },
      ledger: {
        record: async (call) => {
          ledgerRows.push(call);
          return { callId: 'model-call-1', costUsd: 0 };
        },
      },
      config: { maxOutputTokens: 100 },
      providers: READY_PROVIDERS,
      logger,
      access: {
        model: async (ownerId, model) => {
          verdictAsks.push(`${ownerId} ${model}`);
          return row.verdict;
        },
        defaultChatModel: async () => 'anthropic/claude-default',
      },
      audit: async (entry) => {
        audits.push(entry);
      },
      clock: {
        now: () => new Date(0),
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
              messages: [{ role: 'user', content: 'Привет' }],
              tools: [],
              streamsText: false,
              training: false,
              signal: cancel.signal,
              logger,
            })
            .then(
              (result) =>
                result.kind === 'not_started'
                  ? `not_started ${result.verdict.reason}`
                  : result.kind,
              () => 'rejects',
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
      row.act === 'call'
        ? 'owner-1 anthropic/claude-turn'
        : 'owner-1 anthropic/claude-default',
    ]);
    expect(providerCalls).toBe(row.providerCalls);
    // The input of an estimate is the sent request in UTF-8 bytes, four to a token (these calls have no tools).
    const sentBytes =
      sent === undefined
        ? 0
        : Buffer.byteLength(sent.instructions, 'utf8') +
          Buffer.byteLength(JSON.stringify([sent.messages, []]), 'utf8');
    expect(ledgerRows.map(({ price, usage }) => ({ price, usage }))).toEqual(
      row.ledgerRows.map(({ price, estimatedOutputTokens }) => ({
        price,
        usage:
          estimatedOutputTokens === undefined
            ? LEDGER_USAGE
            : {
                inputTokens: Math.ceil(sentBytes / 4),
                outputTokens: estimatedOutputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
      })),
    );
    expect(audits).toEqual(row.audits);
  });
});

// agent-harness KD-3: an answer the provider ended at the output length limit is marked `cutOff`, any other
// finish reason is not; the flag is the same for every caller of `call` (model step, compaction).
describe('ModelClient marks an answer cut off at the length limit', () => {
  it.each<[string | undefined, boolean]>([
    ['length', true],
    ['stop', false],
    ['tool-calls', false],
    [undefined, false],
  ])('finish reason %s gives cutOff %s', async (finishReason, cutOff) => {
    const logger = loggerDouble();
    const client = createModelClient({
      turnClient: {
        async streamTurn() {
          return {
            finishReason,
            text: 'a text',
            toolCalls: [],
            usage: LEDGER_USAGE,
          };
        },
      },
      ledger: { record: async () => ({ callId: 'model-call-1', costUsd: 0 }) },
      config: { maxOutputTokens: 100 },
      providers: READY_PROVIDERS,
      logger,
      access: ALLOWING_GATE,
      audit: async () => {},
    });

    const result = await client.call({
      ownerId: 'owner-1',
      rootId: 'root-1',
      taskId: 'agent-1',
      agentName: 'chat',
      model: 'anthropic/claude-turn',
      instructions: 'You are a chat.',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      streamsText: false,
      training: false,
      signal: new AbortController().signal,
      logger,
    });

    expect(result).toMatchObject({ kind: 'answer', cutOff });
  });
});
