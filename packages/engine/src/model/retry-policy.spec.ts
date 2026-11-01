import type { Clock, TaskContext } from '@agent-os/runtime';
import { z } from 'zod';
import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type {
  CallLedger,
  ReservationClosing,
  ReservationOutcome,
  ReservationRequest,
} from './ledger.js';
import { createModelGateway, type ModelCallResult } from './model-gateway.js';
import type { RoleGeneration, RoleModelClient } from './role-agent.js';
import type { TokenCounter, TokenCountResult } from './token-counter.js';

// Error handling of design-engine.md: how each outcome of `generate` drives ModelGateway.
// Provider errors (statusCode 429, 500, 529, network without statusCode) and a failed count are
// retried twice, each call under its own reservation, then `model_unavailable`; an invalid output
// and a refusal (`content-filter`) are retried once, then `invalid_model_output`, the refusal's
// usage charged; an aborted call is no answer and is not retried.
// Defects caught: a retry without a new reservation, an aborted call retried or taken as an answer,
// a refusal that charges nothing or is retried more than once.
// Boundary doubles: the model client, the reservation ledger, the token counter and the clock.

const NOW = new Date('2026-11-01T10:00:00.000Z');
const IN_ONE_HOUR = new Date(NOW.getTime() + 3_600_000);
const COUNTED = 1_000;
const MARGIN = 3_200;
const MAX_OUTPUT = 8_000;
const RESERVED = COUNTED + MARGIN + MAX_OUTPUT;
const HAIKU = 'anthropic/claude-haiku-5-5';

const OutputSchema = z.object({ claims: z.array(z.string()) });
type Output = z.infer<typeof OutputSchema>;

/** Moves the world while the call runs: a cancel of the investigation or the arrival of `notAfter`. */
interface CallControls {
  cancel(): void;
  reachNotAfter(): void;
}
type Step = RoleGeneration | Error | ((controls: CallControls) => RoleGeneration);

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
});
const answer: RoleGeneration = {
  finishReason: 'stop',
  object: { claims: ['payments failed first'] },
  usage: usage(1_000, 200),
};
const invalid: RoleGeneration = {
  finishReason: 'stop',
  object: { claims: 'not a list' },
  usage: usage(1_000, 150),
};
const refusal: RoleGeneration = {
  finishReason: 'content-filter',
  object: undefined,
  usage: usage(900, 40),
};
const apiError = (statusCode?: number): Error =>
  Object.assign(new Error('provider error'), {
    name: 'AI_APICallError',
    ...(statusCode === undefined ? {} : { statusCode }),
  });
/** The call is cancelled while it runs; the client then resolves the way `generate` does. */
const cancelledThen =
  (generation: RoleGeneration) =>
  (controls: CallControls): RoleGeneration => {
    controls.cancel();
    return generation;
  };
/** `notAfter` arrives while the call runs and interrupts it. */
const interruptedAtNotAfter = (controls: CallControls): RoleGeneration => {
  controls.reachNotAfter();
  return aborted;
};
const aborted: RoleGeneration = {
  finishReason: 'aborted',
  object: undefined,
  usage: usage(0, 0),
};

interface Scenario {
  steps: Step[];
  counts?: TokenCountResult[];
  refuse?: 'task_tokens_exhausted';
  notAfter?: Date;
  /** The investigation is cancelled before the call is asked for. */
  cancelledBefore?: boolean;
}

interface Observed {
  result: ModelCallResult<Output>;
  generateCalls: number;
  countCalls: number;
  reservations: ReservationRequest[];
  closings: Pick<ReservationClosing, 'callId' | 'status' | 'chargedTokens'>[];
  delays: number[];
  events: string[];
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
    budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs: 600_000, maxTokens: 100_000 },
    upstream: [],
    checkpoint: null,
    signal,
    deadlineAt: IN_ONE_HOUR,
    reserveToolCall: unused,
    putEvidence: unused,
    saveCheckpoint: unused,
    registerWait: unused,
    withAttemptGuard: unused,
  };
}

async function run(scenario: Scenario): Promise<Observed> {
  const controller = new AbortController();
  const events: string[] = [];
  const reservations: ReservationRequest[] = [];
  const closings: Observed['closings'] = [];
  const delays: number[] = [];
  const steps = [...scenario.steps];
  const counts = [...(scenario.counts ?? [])];
  const notAfterTimers: (() => void)[] = [];
  let generateCalls = 0;
  let countCalls = 0;
  if (scenario.cancelledBefore === true) controller.abort();

  const ledger: CallLedger = {
    reserve(_ctx, request): Promise<ReservationOutcome> {
      if (scenario.refuse !== undefined) {
        return Promise.resolve({ outcome: 'refused', code: scenario.refuse });
      }
      reservations.push(request);
      events.push('reserve');
      return Promise.resolve({ outcome: 'reserved', callId: `call-${reservations.length}` });
    },
    close(_ctx, closing) {
      closings.push({ callId: closing.callId, status: closing.status, chargedTokens: closing.chargedTokens });
      events.push(`close:${closing.status}`);
      return Promise.resolve('closed');
    },
  };
  const client: RoleModelClient = {
    generate() {
      generateCalls += 1;
      const step = steps.shift();
      if (step === undefined) throw new Error('the scenario has no more model steps');
      if (step instanceof Error) return Promise.reject(step);
      const controls: CallControls = {
        cancel: () => controller.abort(),
        reachNotAfter: () => notAfterTimers.splice(0).forEach((fire) => fire()),
      };
      return Promise.resolve(typeof step === 'function' ? step(controls) : step);
    },
  };
  const tokenCounter: TokenCounter = {
    countInputTokens: () => {
      countCalls += 1;
      return Promise.resolve(counts.shift() ?? { outcome: 'counted', inputTokens: COUNTED });
    },
  };
  // Retry delays fire at once and are recorded; the `notAfter` timer, an hour away, fires only
  // when a step reaches it.
  const clock: Clock = {
    now: () => NOW,
    random: () => 0,
    setTimer: (ms, callback) => {
      if (ms < 60_000) {
        delays.push(ms);
        queueMicrotask(callback);
      } else {
        notAfterTimers.push(callback);
      }
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
    ctx: taskContext(controller.signal),
    role: 'worker',
    roleConfig: { model: HAIKU, effort: 'low', maxOutputTokens: MAX_OUTPUT, marginTokens: MARGIN },
    instructions: 'You analyse log records.',
    messages: [{ role: 'user', content: 'Which service failed first?' }],
    outputSchema: OutputSchema,
    notAfter: scenario.notAfter ?? IN_ONE_HOUR,
    checkpointAnswer: () => {
      events.push('checkpoint');
      return Promise.resolve();
    },
  });
  return { result, generateCalls, countCalls, reservations, closings, delays, events };
}

const failedClosings = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ callId: `call-${i + 1}`, status: 'failed' as const, chargedTokens: 0 }));
const modelUnavailable = { outcome: 'failed', code: 'model_unavailable', failureClass: 'transport_protocol' } as const;

describe('ModelGateway retry policy', () => {
  it.each([
    ['statusCode 429', 429],
    ['statusCode 500', 500],
    ['statusCode 529', 529],
    ['a network error without statusCode', undefined],
  ])('retries %s twice, each call under its own reservation, then model_unavailable', async (_case, statusCode) => {
    const observed = await run({ steps: [apiError(statusCode), apiError(statusCode), apiError(statusCode)] });

    expect(observed.result).toEqual(modelUnavailable);
    expect(observed.generateCalls).toBe(3);
    expect(observed.reservations.map((r) => r.reservedTokens)).toEqual([RESERVED, RESERVED, RESERVED]);
    expect(observed.closings).toEqual(failedClosings(3));
    expect(observed.delays).toEqual([1_000, 3_000]);
  });

  it.each<[string, Scenario, Partial<Observed>]>([
    [
      'a provider error twice, then an answer — answered on the third reservation',
      { steps: [apiError(500), apiError(529), answer] },
      {
        result: { outcome: 'answered', output: { claims: ['payments failed first'] } },
        generateCalls: 3,
        closings: [...failedClosings(2), { callId: 'call-3', status: 'settled', chargedTokens: 1_200 }],
        events: ['reserve', 'close:failed', 'reserve', 'close:failed', 'reserve', 'checkpoint', 'close:settled'],
      },
    ],
    [
      'a final provider status (400) — model_unavailable without a retry',
      { steps: [apiError(400)] },
      { result: modelUnavailable, generateCalls: 1, closings: failedClosings(1), delays: [] },
    ],
    [
      'a failed count three times — model_unavailable, nothing reserved',
      {
        steps: [],
        counts: [
          { outcome: 'failed', statusCode: 503 },
          { outcome: 'failed', statusCode: null },
          { outcome: 'failed', statusCode: 500 },
        ],
      },
      { result: modelUnavailable, generateCalls: 0, reservations: [], delays: [1_000, 3_000] },
    ],
    [
      'an invalid output twice — one retry, then invalid_model_output, both calls settled',
      { steps: [invalid, invalid] },
      {
        result: { outcome: 'invalid_model_output' },
        generateCalls: 2,
        closings: [
          { callId: 'call-1', status: 'settled', chargedTokens: 1_150 },
          { callId: 'call-2', status: 'settled', chargedTokens: 1_150 },
        ],
        delays: [],
      },
    ],
    [
      'a refusal twice — one retry, then invalid_model_output, the refusal usage charged',
      { steps: [refusal, refusal] },
      {
        result: { outcome: 'invalid_model_output' },
        generateCalls: 2,
        closings: [
          { callId: 'call-1', status: 'settled', chargedTokens: 940 },
          { callId: 'call-2', status: 'settled', chargedTokens: 940 },
        ],
      },
    ],
    [
      'an invalid output, then an answer — answered',
      { steps: [invalid, answer] },
      {
        result: { outcome: 'answered', output: { claims: ['payments failed first'] } },
        generateCalls: 2,
        events: ['reserve', 'close:settled', 'reserve', 'checkpoint', 'close:settled'],
      },
    ],
    [
      'a call aborted by the cancel — no answer, no retry, the reservation left open',
      { steps: [cancelledThen(aborted), answer] },
      {
        result: { outcome: 'no_answer', reason: 'cancelled' },
        generateCalls: 1,
        closings: [],
        events: ['reserve'],
      },
    ],
    [
      'a call interrupted at notAfter — no answer, no retry, the reservation left open',
      { steps: [interruptedAtNotAfter, answer] },
      {
        result: { outcome: 'no_answer', reason: 'deadline' },
        generateCalls: 1,
        closings: [],
        events: ['reserve'],
      },
    ],
    [
      'an answer that resolves after the cancel — dropped, no checkpoint, nothing closed',
      { steps: [cancelledThen(answer)] },
      { result: { outcome: 'no_answer', reason: 'cancelled' }, generateCalls: 1, closings: [], events: ['reserve'] },
    ],
    [
      'the signal already aborted by a cancel — no count, no reservation, no call (invariant 4)',
      { steps: [answer], cancelledBefore: true },
      { result: { outcome: 'no_answer', reason: 'cancelled' }, generateCalls: 0, countCalls: 0, reservations: [] },
    ],
    [
      'notAfter already passed — no count, no reservation, no call',
      { steps: [answer], notAfter: NOW },
      { result: { outcome: 'no_answer', reason: 'deadline' }, generateCalls: 0, reservations: [] },
    ],
    [
      'a refused task reservation — task_tokens_exhausted before the network',
      { steps: [answer], refuse: 'task_tokens_exhausted' },
      {
        result: { outcome: 'failed', code: 'task_tokens_exhausted', failureClass: 'budget_exhausted' },
        generateCalls: 0,
      },
    ],
  ])('%s', async (_case, scenario, expected) => {
    const observed = await run(scenario);

    expect(observed).toMatchObject(expected);
  });
});
