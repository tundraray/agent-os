// design-core.md KD-6, Flow 2, Contract `Agents.embeddings.embed`: AC-07.1 and DC-8 (vectors in the texts' order,
// each of unit length), AC-07.2 (no model chosen — no request, no ledger row), AC-07.3 (503 after the retries —
// `provider_unavailable`, the provider's body in the log, no ledger row), AC-07.4 (a vector of another length —
// `dimension_mismatch`, the batch's ledger row written), AC-06.3 (the model the gate names now is the one called),
// AC-07.5 (no employee — the `platform` owner), DC-9 (101 texts — two batches and two rows; an empty list — no
// request), DC-11 (no token count — an estimate by bytes, `estimated` in the log). The service, `classifyRejection`
// and the Gemini adapter are real; the seam, the gate, the registry and the ledger are doubles.
import type { Logger } from '@agent-os/common';
import type { Clock, ModelCallRecord } from '@agent-os/runtime';

import type { EmbeddingVerdict } from '../access-gate';
import { createProviderRegistryDouble, createScriptedEmbeddings, type ScriptedEmbeddings } from '../testing';
import { createEmbeddings } from './embeddings';

const SMALL: EmbeddingVerdict = {
  kind: 'allowed',
  model: 'gemini/small-embedding',
  inputUsdPerMTok: 0.15,
  dimensions: 2,
};
/** The catalogue's input rate and zeros elsewhere (KD-6). */
const INPUT_ONLY_PRICE = { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0, cacheReadUsdPerMTok: 0, cacheWriteUsdPerMTok: 0 };
const NOT_CONFIGURED: EmbeddingVerdict = { kind: 'refused', reason: 'model_not_configured' };
const BODY_503 = '{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}';
const MANY_TEXTS = Array.from({ length: 101 }, (_, index) => `text ${index}`);

interface Row {
  readonly verdict: EmbeddingVerdict;
  readonly ownerId: string | null;
  readonly texts: readonly string[];
  readonly seam?: (seam: ScriptedEmbeddings) => void;
  /** `vectors <count>` or `unavailable <reason>`. */
  readonly outcome: string;
  /** Unit-length vectors computed by hand, when the row checks them. */
  readonly vectors?: readonly (readonly number[])[];
  /** Texts per provider request, in order (each retry is a request). */
  readonly requests: readonly number[];
  readonly calledModel?: string;
  readonly pauses: readonly number[];
  /** Owner, model and input tokens of each ledger row. */
  readonly ledger: readonly string[];
  readonly log?: { readonly message: string; readonly fields: Readonly<Record<string, unknown>> };
}

function loggerDouble(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return logger;
}

describe('Agents.embeddings.embed answers vectors or a reason, with a ledger row per answered batch', () => {
  it.each<[string, Row]>([
    [
      'vectors in the texts order, each of unit length, the spend on the employee (AC-07.1, DC-8)',
      {
        verdict: SMALL,
        ownerId: 'owner-1',
        texts: ['a', 'abc'],
        // The double answers [1, 2] and [3, 4]: scaled by √5 and by 5.
        outcome: 'vectors 2',
        vectors: [
          [0.4472136, 0.8944272],
          [0.6, 0.8],
        ],
        requests: [2],
        calledModel: 'gemini/small-embedding',
        pauses: [],
        ledger: ['owner-1 gemini/small-embedding 20'],
      },
    ],
    [
      'no embedding model chosen: no request, no ledger row (AC-07.2)',
      {
        verdict: NOT_CONFIGURED,
        ownerId: 'owner-1',
        texts: ['a'],
        outcome: 'unavailable model_not_configured',
        requests: [],
        pauses: [],
        ledger: [],
      },
    ],
    [
      '503 on all three attempts: retried at 1 s and 3 s, provider_unavailable, the body in the log (AC-07.3)',
      {
        verdict: SMALL,
        ownerId: 'owner-1',
        texts: ['a'],
        seam: (seam) => {
          seam.failure = { statusCode: 503, body: BODY_503 };
        },
        outcome: 'unavailable provider_unavailable',
        requests: [1, 1, 1],
        pauses: [1000, 3000],
        ledger: [],
        log: {
          message: 'embedding call failed',
          fields: { provider: 'gemini', reason: 'provider_unavailable', statusCode: 503, responseBody: BODY_503 },
        },
      },
    ],
    [
      'a vector of 3072 for a model of 768: dimension_mismatch, the batch row is written (AC-07.4)',
      {
        verdict: { ...SMALL, dimensions: 768 },
        ownerId: 'owner-1',
        texts: ['a'],
        seam: (seam) => {
          seam.vectorLength = 3072;
        },
        outcome: 'unavailable dimension_mismatch',
        requests: [1],
        pauses: [],
        ledger: ['owner-1 gemini/small-embedding 10'],
      },
    ],
    [
      'no employee and a newly chosen model: that model is called, the spend on platform (AC-06.3, AC-07.5)',
      {
        verdict: { ...SMALL, model: 'gemini/embedding-v2' },
        ownerId: null,
        texts: ['a'],
        outcome: 'vectors 1',
        requests: [1],
        calledModel: 'gemini/embedding-v2',
        pauses: [],
        ledger: ['platform gemini/embedding-v2 10'],
      },
    ],
    [
      '101 texts: two batches one after another, a ledger row each (DC-9)',
      {
        verdict: SMALL,
        ownerId: 'owner-1',
        texts: MANY_TEXTS,
        outcome: 'vectors 101',
        requests: [100, 1],
        pauses: [],
        ledger: ['owner-1 gemini/small-embedding 1000', 'owner-1 gemini/small-embedding 10'],
      },
    ],
    [
      'an empty list: vectors without a request (DC-9)',
      {
        verdict: SMALL,
        ownerId: 'owner-1',
        texts: [],
        outcome: 'vectors 0',
        requests: [],
        pauses: [],
        ledger: [],
      },
    ],
    [
      'no token count: the row is an estimate by bytes, `estimated` in the log (DC-11)',
      {
        verdict: SMALL,
        ownerId: 'owner-1',
        // 3 + 8 = 11 UTF-8 bytes → ⌈11 / 4⌉ = 3 tokens.
        texts: ['abc', 'abcdefgh'],
        seam: (seam) => {
          seam.withoutTokenCount = true;
        },
        outcome: 'vectors 2',
        requests: [2],
        pauses: [],
        ledger: ['owner-1 gemini/small-embedding 3'],
        log: {
          message: 'embedding batch recorded with estimated usage',
          fields: { provider: 'gemini', inputTokens: 3, estimated: true },
        },
      },
    ],
  ])('%s', async (_, row) => {
    const seam = createScriptedEmbeddings();
    row.seam?.(seam);
    const pauses: number[] = [];
    const ledgerRows: ModelCallRecord[] = [];
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
    const embeddings = createEmbeddings({
      client: seam.client,
      access: { embedding: async () => row.verdict },
      providers: createProviderRegistryDouble({ gemini: 'ready' }),
      ledger: {
        record: async (call) => {
          ledgerRows.push(call);
          return { callId: `model-call-${ledgerRows.length}`, costUsd: 0 };
        },
      },
      clock,
    });

    const result = await embeddings.embed({
      texts: row.texts,
      inputType: 'document',
      ownerId: row.ownerId,
      taskId: null,
      signal: new AbortController().signal,
      logger,
    });

    const outcome =
      result.kind === 'vectors' ? `vectors ${result.vectors.length}` : `unavailable ${result.reason}`;
    expect(outcome).toBe(row.outcome);
    if (result.kind === 'vectors') {
      for (const vector of result.vectors) {
        expect(Math.hypot(...vector)).toBeCloseTo(1, 6);
      }
    }
    if (row.vectors !== undefined && result.kind === 'vectors') {
      const rounded = result.vectors.map((vector) => vector.map((value) => Number(value.toFixed(6))));
      expect(rounded).toEqual(row.vectors.map((vector) => vector.map((value) => Number(value.toFixed(6)))));
    }
    expect(seam.calls.map((call) => call.texts.length)).toEqual(row.requests);
    // The batches go in the texts' order; a retry sends its batch again.
    const sent = new Set(seam.calls.flatMap((call) => call.texts));
    expect([...sent]).toEqual(row.requests.length === 0 ? [] : row.texts);
    if (row.calledModel !== undefined) {
      expect(seam.calls.map((call) => call.model)).toEqual([row.calledModel]);
    }
    expect(pauses).toEqual(row.pauses);
    expect(ledgerRows.map((call) => `${call.ownerId} ${call.model} ${call.usage.inputTokens}`)).toEqual(row.ledger);
    for (const call of ledgerRows) {
      expect(call.price).toEqual(INPUT_ONLY_PRICE);
      expect(call.usage).toMatchObject({ outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
    if (row.log !== undefined) {
      const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls].filter(
        ([message]) => message === row.log?.message,
      );
      expect(logged.at(-1)?.[1]).toMatchObject(row.log.fields);
    }
  });
});
