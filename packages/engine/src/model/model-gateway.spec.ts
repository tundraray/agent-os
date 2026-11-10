import type { Clock, RuntimeTx, TaskContext } from '@agent-os/runtime';
import { z } from 'zod';
import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import type { RoleModel } from '../ports.js';
import type { CallLedger, ReservationOutcome, ReservationRequest } from './ledger.js';
import { type AgentTurnResult, createModelGateway } from './model-gateway.js';
import {
  type AgentToolDefinition,
  type AgentTurnGeneration,
  type AgentTurnModelClient,
  countedTurnTools,
} from './role-agent.js';
import type { CountedTool, TokenCountResult } from './token-counter.js';

// The reserve wait of ModelGateway (design-engine.md, KD-5, DC-5, Contract `CallLedger.reserve`): on `busy` the gateway
// waits 2 seconds on the clock and asks again with the same counted input, without counting it again, until the ledger
// answers anything else or `busyWaitMs` passes; a cancel or `notAfter` during the wait ends it with `no_answer` and no
// model call; `stopping` on a later reserve ends it as a cancel does (ADR-0006).
// Defects caught: a busy turn refused or retried without a wait, a recount per try, a wait of another length, a wait
// that goes on after the cancel or `notAfter`, or a model call after `stopping`.
// Boundary doubles: the ledger, the model client, the token counter and the clock (timers fire when the test says).

const NOW = new Date('2026-11-01T10:00:00.000Z');
const NOT_AFTER = new Date(NOW.getTime() + 3_600_000);
const COUNTED = 40_000;
const MARGIN = 3_200;
const MAX_OUTPUT = 8_000;
const HAIKU = 'anthropic/claude-haiku-5-5';

const BUSY: ReservationOutcome = { outcome: 'busy' };
const RESERVED: ReservationOutcome = { outcome: 'reserved', callId: 'call-1' };

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

const RESERVED_TOKENS = 51_200;
const noAnswer = (reason: 'cancelled' | 'deadline') => ({ outcome: 'no_answer', reason }) as const;

// The agent turn of ModelGateway (design-agent-core.md, KD-1, KD-6, «Резерв хода агента», Error Handling): the reserve
// of a turn waits for other calls' reserves only up to `busyWaitMs`; then it answers `busy_wait_exhausted` without a
// ledger row and without a model call. The answer of a turn is written by the close of its ledger row, in the same
// guarded transaction. The ceiling refusal of an agent run is `run_tokens_exhausted`.
// Defects caught: a model call or ledger row after the limit, an answer written outside the close, a run ceiling
// reported as `task_tokens_exhausted`.
// Boundary doubles: the ledger, the model clients, the token counter and the clock.

interface TurnObserved {
  readonly result: AgentTurnResult;
  readonly reserves: readonly ReservationRequest[];
  readonly waits: readonly number[];
  readonly turnCalls: number;
  /** Turn counts the gateway asked for. */
  readonly counts: number;
  /** The tools of the last turn count. */
  readonly countedTools: readonly CountedTool[];
  /** What happened at the ledger's close and the answer write, in order. */
  readonly events: readonly string[];
}

interface TurnScenario {
  readonly reserves: readonly ReservationOutcome[];
  readonly busyWaitMs?: number;
  /** The counter's answers to the turn counts, in order; `COUNTED` once they run out. */
  readonly counts?: readonly TokenCountResult[];
  /** `windowTokens − marginTokens` of the definition. */
  readonly inputLimitTokens?: number;
  /** What happens while the gateway waits its first time: the investigation is cancelled, or `notAfter` arrives. */
  readonly duringFirstWait?: 'cancel' | 'reach_not_after';
}

const TURN_ANSWER: AgentTurnGeneration = {
  finishReason: 'tool-calls',
  text: 'reading notes',
  toolCalls: [{ toolCallId: 'tc-1', toolName: 'memory_read', args: { after: 0 } }],
  usage: { inputTokens: 30_000, outputTokens: 500, cachedInputTokens: 20_000, cacheCreationInputTokens: 0 },
};

/** A language model of the current specification that is never asked: the turn client double answers instead. */
const TURN_MODEL: Extract<RoleModel, { specificationVersion: 'v4' }> = {
  specificationVersion: 'v4',
  provider: 'anthropic.messages',
  modelId: 'claude-haiku-5-5',
  supportedUrls: {},
  doGenerate: (): Promise<never> => Promise.reject(new Error('the turn client double answers the turn')),
  doStream: () => Promise.reject(new Error('a turn does not stream')),
};

const TURN_TOOLS: readonly AgentToolDefinition[] = [
  { name: 'memory_read', description: 'Reads notes', inputSchema: z.strictObject({ after: z.number().int().nonnegative() }) },
];

async function runTurn(scenario: TurnScenario): Promise<TurnObserved> {
  const answers = [...scenario.reserves];
  const countAnswers = [...(scenario.counts ?? [])];
  const reserves: ReservationRequest[] = [];
  const waits: number[] = [];
  const events: string[] = [];
  let turnCalls = 0;
  let counts = 0;
  let countedTools: readonly CountedTool[] = [];
  const cancel = new AbortController();
  let now = NOW;
  const closeTx = { marker: 'close transaction' } as unknown as RuntimeTx;

  const ledger: CallLedger = {
    reserve(_ctx, request) {
      reserves.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error('the scenario has no more reserve answers');
      return Promise.resolve(next);
    },
    async close(_ctx, closing) {
      events.push(`close ${closing.callId} ${closing.status}`);
      await closing.writeAnswer?.(closeTx);
      events.push('close committed');
      return 'closed';
    },
  };
  const turnClient: AgentTurnModelClient = {
    generateTurn() {
      turnCalls += 1;
      return Promise.resolve(TURN_ANSWER);
    },
  };
  // A wait (under a minute) is recorded and fires on the next microtask; the `notAfter` timer, an hour away, never fires.
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
  const gateway = createModelGateway({
    models: new Map([[HAIKU, TURN_MODEL]]),
    tokenCounter: {
      countTurnInputTokens: (request) => {
        counts += 1;
        countedTools = request.tools;
        return Promise.resolve(countAnswers.shift() ?? { outcome: 'counted', inputTokens: COUNTED });
      },
    },
    catalog: DEFAULT_MODEL_CATALOG,
    clock,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    ledger,
    turnClient,
  });
  const result = await gateway.turn({
    ctx: taskContext(cancel.signal),
    agentName: 'lead',
    definition: { model: HAIKU, effort: 'low', maxOutputTokens: MAX_OUTPUT, marginTokens: MARGIN },
    promptVersion: '0123456789ab',
    instructions: 'You look for the cause.',
    messages: [{ role: 'user', content: 'Find why the job fails.' }],
    tools: TURN_TOOLS,
    toolChoice: 'auto',
    inputLimitTokens: scenario.inputLimitTokens ?? 100_000,
    transcriptInput: {
      instructions: 'You look for the cause.',
      view: { throughSeq: 0, stubbedCalls: [], collapsedTurns: [], stage: 0 },
    },
    notAfter: NOT_AFTER,
    busyWaitMs: scenario.busyWaitMs ?? 30_000,
    writeAnswer: (tx, written) => {
      events.push(`answer ${written.callId} ${written.toolCalls.map((call) => call.toolName).join(',')}`);
      expect(tx).toBe(closeTx);
      return Promise.resolve();
    },
  });
  return { result, reserves, waits, turnCalls, counts, countedTools, events };
}

const ANSWERED: AgentTurnResult = {
  outcome: 'answered',
  answer: { callId: 'call-1', text: 'reading notes', toolCalls: TURN_ANSWER.toolCalls },
};

describe('ModelGateway reserve wait', () => {
  it('busy twice, then reserved: waits 2000 ms before each new reserve, with the same counted input and one count', async () => {
    const observed = await runTurn({ reserves: [BUSY, BUSY, RESERVED] });

    expect(observed.result).toEqual(ANSWERED);
    expect(observed.waits).toEqual([2_000, 2_000]);
    expect(observed.counts).toBe(1);
    expect(observed.reserves.map((request) => [request.countedInputTokens, request.reservedTokens])).toEqual([
      [COUNTED, RESERVED_TOKENS],
      [COUNTED, RESERVED_TOKENS],
      [COUNTED, RESERVED_TOKENS],
    ]);
    expect(observed.turnCalls).toBe(1);
  });

  it.each<[string, TurnScenario, AgentTurnResult, number]>([
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
    const observed = await runTurn(scenario);

    expect(observed.result).toEqual(expected);
    expect(observed.reserves).toHaveLength(reserveCount);
    expect(observed.waits).toEqual([2_000]);
    expect(observed.counts).toBe(1);
    expect(observed.turnCalls).toBe(0);
  });
});

describe('ModelGateway agent turn', () => {
  it('answers busy_wait_exhausted after the reserve limit, with no ledger row and no model call', async () => {
    const observed = await runTurn({ reserves: [BUSY, BUSY, BUSY, BUSY], busyWaitMs: 4_000 });

    expect(observed.result).toEqual({ outcome: 'no_answer', reason: 'busy_wait_exhausted' });
    expect(observed.waits).toEqual([2_000, 2_000]);
    expect(observed.reserves).toHaveLength(3);
    expect(observed.turnCalls).toBe(0);
    expect(observed.events).toEqual([]);
  });

  it('writes the answer of a turn in the transaction that closes its ledger row', async () => {
    const observed = await runTurn({ reserves: [RESERVED] });

    expect(observed.result).toEqual(ANSWERED);
    expect(observed.events).toEqual(['close call-1 settled', 'answer call-1 memory_read', 'close committed']);
    expect(observed.reserves[0]).toMatchObject({ role: 'agent', reservedTokens: COUNTED + MARGIN + MAX_OUTPUT });
  });

  it('refuses a turn over its task ceiling with run_tokens_exhausted', async () => {
    const observed = await runTurn({ reserves: [{ outcome: 'refused', code: 'task_tokens_exhausted' }] });

    expect(observed.result).toEqual({ outcome: 'failed', code: 'run_tokens_exhausted', failureClass: 'budget_exhausted' });
  });
});

// The counted input of a turn decides (design-agent-core.md, DC-30, «Предел входа хода агента», half of UC-E15 in the
// gateway): the gateway counts the whole turn input before the reserve; over `windowTokens − marginTokens` the turn
// ends `window_exceeded` with the counted number, with no reserve, no ledger row and no model call; an input right at
// the limit goes on and is reserved from the counted input. A count the provider refuses goes through the gateway's
// retries and ends `model_unavailable`, again with no reserve and no ledger row.
// Defects caught: a reserve, a ledger row or a model call over the window; a reserve from an estimate instead of the
// count; a limit off by one; a failed count that reserves or answers anything but `model_unavailable`.
// Boundary doubles: the ledger, the model client, the token counter and the clock.

describe('ModelGateway agent turn against its counted input', () => {
  const LIMIT = 29_000;

  // DC-30: the count takes the tool schemas in the form the turn's request sends them (Mastra's conversion for the
  // model), not as zod writes them. Defect caught: the count path converting the schemas on its own again.
  it('counts the tool schemas the turn sends on its model', async () => {
    const observed = await runTurn({ reserves: [RESERVED] });

    expect(observed.countedTools).toEqual(await countedTurnTools(TURN_MODEL, TURN_TOOLS));
    expect(observed.countedTools[0]?.inputSchema).not.toEqual(z.toJSONSchema(TURN_TOOLS[0]!.inputSchema));
  });

  it.each<[string, number, AgentTurnResult, number]>([
    [
      'one token over the limit: window_exceeded with the count',
      LIMIT + 1,
      { outcome: 'no_answer', reason: 'window_exceeded', countedInputTokens: LIMIT + 1 },
      0,
    ],
    [
      'right at the limit: the turn goes on',
      LIMIT,
      { outcome: 'answered', answer: { callId: 'call-1', text: 'reading notes', toolCalls: TURN_ANSWER.toolCalls } },
      1,
    ],
  ])('counted input %s', async (_case, counted, expected, modelCalls) => {
    const observed = await runTurn({
      reserves: [RESERVED],
      counts: [{ outcome: 'counted', inputTokens: counted }],
      inputLimitTokens: LIMIT,
    });

    expect(observed.result).toEqual(expected);
    expect(observed.turnCalls).toBe(modelCalls);
    expect(observed.reserves.map((request) => [request.countedInputTokens, request.reservedTokens])).toEqual(
      modelCalls === 0 ? [] : [[LIMIT, LIMIT + MARGIN + MAX_OUTPUT]],
    );
    expect(observed.events).toEqual(
      modelCalls === 0 ? [] : ['close call-1 settled', 'answer call-1 memory_read', 'close committed'],
    );
  });

  it('a refused count goes through the retries and ends model_unavailable, with no reserve and no ledger row', async () => {
    const refused: TokenCountResult = { outcome: 'failed', statusCode: 529, errorClass: 'overloaded_error' };

    const observed = await runTurn({ reserves: [RESERVED], counts: [refused, refused, refused] });

    expect(observed.result).toEqual({ outcome: 'failed', code: 'model_unavailable', failureClass: 'transport_protocol' });
    expect(observed.counts).toBe(3);
    expect(observed.reserves).toEqual([]);
    expect(observed.turnCalls).toBe(0);
    expect(observed.events).toEqual([]);
  });
});
