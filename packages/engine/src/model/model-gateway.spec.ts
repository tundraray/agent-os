import type { Clock, TaskContext } from '@agent-os/runtime';
import { z } from 'zod';
import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type { CallLedger, ReservationOutcome, ReservationRequest } from './ledger.js';
import { createModelGateway, type ModelCallResult } from './model-gateway.js';
import type { RoleGeneration, RoleModelClient } from './role-agent.js';
import type { TokenCounter } from './token-counter.js';

// The reserve wait of ModelGateway (design-engine.md, KD-5, DC-5, Contract `CallLedger.reserve`): on `busy` the gateway
// waits 2 seconds on the clock and asks again with the same counted input, without counting it again, until the ledger
// answers anything else; a cancel or `notAfter` during the wait ends it with `no_answer` and no model call; `stopping`
// on a later reserve ends it as a cancel does (ADR-0006).
// Defects caught: a busy call refused or retried without a wait, a recount per try, a wait of another length, a wait
// that goes on after the cancel or `notAfter`, or a model call after `stopping`.
// Boundary doubles: the ledger, the model client, the token counter and the clock (timers fire when the test says).

const NOW = new Date('2026-11-01T10:00:00.000Z');
const NOT_AFTER = new Date(NOW.getTime() + 3_600_000);
const COUNTED = 40_000;
const MARGIN = 3_200;
const MAX_OUTPUT = 8_000;
const HAIKU = 'anthropic/claude-haiku-5-5';

const OutputSchema = z.object({ claims: z.array(z.string()) });
type Output = z.infer<typeof OutputSchema>;

const answer: RoleGeneration = {
  finishReason: 'stop',
  object: { claims: [] },
  text: '{"claims":[]}',
  usage: { inputTokens: 40_000, outputTokens: 1_000, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
};

const BUSY: ReservationOutcome = { outcome: 'busy' };
const RESERVED: ReservationOutcome = { outcome: 'reserved', callId: 'call-1' };

interface Scenario {
  /** The ledger's answers, in order. */
  readonly reserves: readonly ReservationOutcome[];
  /** What happens while the gateway waits its first time: the investigation is cancelled, or `notAfter` arrives. */
  readonly duringFirstWait?: 'cancel' | 'reach_not_after';
}

interface Observed {
  readonly result: ModelCallResult<Output>;
  readonly reserves: readonly ReservationRequest[];
  readonly waits: readonly number[];
  readonly counts: number;
  readonly generateCalls: number;
}

function taskContext(signal: AbortSignal): TaskContext {
  const unused = () => {
    throw new Error('not used by ModelGateway');
  };
  return {
    taskId: '00000000-0000-4000-8000-000000000001',
    investigationId: '00000000-0000-4000-8000-000000000002',
    attempt: 1,
    input: {},
    inputRefs: [],
    expectedOutput: { description: 'claims', completeness: 'all' },
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs: 600_000, maxTokens: 225_600 },
    upstream: [],
    checkpoint: null,
    signal,
    deadlineAt: NOT_AFTER,
    reserveToolCall: unused,
    putEvidence: unused,
    saveCheckpoint: unused,
    registerWait: unused,
    withAttemptGuard: unused,
  };
}

async function run(scenario: Scenario): Promise<Observed> {
  const cancel = new AbortController();
  const answers = [...scenario.reserves];
  const reserves: ReservationRequest[] = [];
  const waits: number[] = [];
  let now = NOW;
  let counts = 0;
  let generateCalls = 0;

  const ledger: CallLedger = {
    reserve(_ctx, request) {
      reserves.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error('the scenario has no more reserve answers');
      return Promise.resolve(next);
    },
    close: () => Promise.resolve('closed'),
  };
  const client: RoleModelClient = {
    generate() {
      generateCalls += 1;
      return Promise.resolve(answer);
    },
  };
  const tokenCounter: TokenCounter = {
    countInputTokens: () => {
      counts += 1;
      return Promise.resolve({ outcome: 'counted', inputTokens: COUNTED });
    },
  };
  // A wait (under a minute) is recorded and fires on the next microtask, after the first one's event; the `notAfter`
  // timer of a model call, an hour away, never fires.
  const clock: Clock = {
    now: () => now,
    random: () => 0,
    setTimer: (ms, callback) => {
      if (ms >= 60_000) return () => undefined;
      waits.push(ms);
      if (waits.length === 1 && scenario.duringFirstWait === 'cancel') cancel.abort();
      if (waits.length === 1 && scenario.duringFirstWait === 'reach_not_after') now = NOT_AFTER;
      queueMicrotask(callback);
      return () => undefined;
    },
  };
  const logger: EngineLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

  const gateway = createModelGateway({
    // The client double never reads the model instance.
    models: new Map([[HAIKU, {} as RoleModel]]),
    tokenCounter,
    catalog: DEFAULT_MODEL_CATALOG,
    clock,
    logger,
    ledger,
    client,
  });
  const result = await gateway.call({
    ctx: taskContext(cancel.signal),
    role: 'worker',
    roleConfig: { model: HAIKU, effort: 'low', maxOutputTokens: MAX_OUTPUT, marginTokens: MARGIN },
    promptVersion: '0123456789ab',
    instructions: 'You analyse log records.',
    messages: [{ role: 'user', content: 'Which service failed first?' }],
    outputSchema: OutputSchema,
    notAfter: NOT_AFTER,
    checkpointAnswer: () => Promise.resolve(),
  });
  return { result, reserves, waits, counts, generateCalls };
}

const RESERVED_TOKENS = 51_200;
const noAnswer = (reason: 'cancelled' | 'deadline') => ({ outcome: 'no_answer', reason }) as const;

describe('ModelGateway reserve wait', () => {
  it('busy twice, then reserved: waits 2000 ms before each new reserve, with the same counted input and one count', async () => {
    const observed = await run({ reserves: [BUSY, BUSY, RESERVED] });

    expect(observed.result).toEqual({ outcome: 'answered', output: { claims: [] } });
    expect(observed.waits).toEqual([2_000, 2_000]);
    expect(observed.counts).toBe(1);
    expect(observed.reserves.map((request) => [request.countedInputTokens, request.reservedTokens])).toEqual([
      [COUNTED, RESERVED_TOKENS],
      [COUNTED, RESERVED_TOKENS],
      [COUNTED, RESERVED_TOKENS],
    ]);
    expect(observed.generateCalls).toBe(1);
  });

  it.each<[string, Scenario, ModelCallResult<Output>, number]>([
    ['the next reserve answers stopping: no answer as by a cancel', { reserves: [BUSY, { outcome: 'stopping' }] }, noAnswer('cancelled'), 2],
    ['the investigation is cancelled while it waits: no answer, no new reserve', { reserves: [BUSY, RESERVED], duringFirstWait: 'cancel' }, noAnswer('cancelled'), 1],
    ['notAfter arrives while it waits: no answer, no new reserve', { reserves: [BUSY, RESERVED], duringFirstWait: 'reach_not_after' }, noAnswer('deadline'), 1],
    [
      'the next reserve is refused: the refusal, no further wait',
      { reserves: [BUSY, { outcome: 'refused', code: 'investigation_tokens_exhausted' }] },
      { outcome: 'failed', code: 'investigation_tokens_exhausted', failureClass: 'budget_exhausted' },
      2,
    ],
  ])('busy, then %s', async (_case, scenario, expected, reserveCount) => {
    const observed = await run(scenario);

    expect(observed.result).toEqual(expected);
    expect(observed.reserves).toHaveLength(reserveCount);
    expect(observed.waits).toEqual([2_000]);
    expect(observed.counts).toBe(1);
    expect(observed.generateCalls).toBe(0);
  });
});
