import type { Clock, TaskContext } from '@agent-os/runtime';
import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import type {
  CallLedger,
  ReservationClosing,
  ReservationOutcome,
  ReservationRequest,
} from './ledger.js';
import { type AgentTurnResult, createModelGateway } from './model-gateway.js';
import type { AgentTurnGeneration, AgentTurnModelClient } from './role-agent.js';
import type { TokenCounter, TokenCountResult } from './token-counter.js';

// Error handling of design-engine.md and design-agent-core.md (Error Handling): how each outcome of a turn request
// drives ModelGateway. Provider errors (statusCode 429, 500, 529, network without statusCode) and a failed count are
// retried twice, each request under its own reservation, then `model_unavailable`; a final status is not retried; an
// aborted request is no answer and is not retried.
// Defects caught: a retry without a new reservation, an aborted request retried or taken as an answer, an answer that
// resolved after the cancel kept, a reservation refused as `stopping` that still calls the model or is retried.
// Transcript (design-self-check.md, Flow 3, AC-01.1, DC-1): every reservation carries the transcript input and prompt
// version, every close the transcript outcome — a provider error `provider_error` without a response. Defects caught: an
// attempt whose close carries no outcome.
// Boundary doubles: the turn client, the reservation ledger, the token counter and the clock.

const NOW = new Date('2026-11-01T10:00:00.000Z');
const IN_ONE_HOUR = new Date(NOW.getTime() + 3_600_000);
const COUNTED = 1_000;
const MARGIN = 3_200;
const MAX_OUTPUT = 8_000;
const RESERVED = COUNTED + MARGIN + MAX_OUTPUT;
const HAIKU = 'anthropic/claude-haiku-5-5';
const PROMPT_VERSION = '0123456789ab';
const INSTRUCTIONS = 'You analyse log records.';
const TRANSCRIPT_INPUT = {
  instructions: INSTRUCTIONS,
  view: { throughSeq: 0, stubbedCalls: [], collapsedTurns: [], stage: 0 },
} as const;

/** Moves the world while the request runs: a cancel of the investigation or the arrival of `notAfter`. */
interface CallControls {
  cancel(): void;
  reachNotAfter(): void;
}
type Step = AgentTurnGeneration | Error | ((controls: CallControls) => AgentTurnGeneration);

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
});
const answer: AgentTurnGeneration = {
  finishReason: 'tool-calls',
  text: '',
  toolCalls: [{ toolCallId: 'tc-1', toolName: 'memory_read', args: {} }],
  usage: usage(1_000, 200),
};
const aborted: AgentTurnGeneration = { finishReason: 'aborted', text: '', toolCalls: [], usage: usage(0, 0) };
const apiError = (statusCode?: number): Error =>
  Object.assign(new Error('provider error'), {
    name: 'AI_APICallError',
    ...(statusCode === undefined ? {} : { statusCode }),
  });
/** The request is cancelled while it runs; the client then resolves the way `generateTurn` does. */
const cancelledThen =
  (generation: AgentTurnGeneration) =>
  (controls: CallControls): AgentTurnGeneration => {
    controls.cancel();
    return generation;
  };
/** `notAfter` arrives while the request runs and interrupts it. */
const interruptedAtNotAfter = (controls: CallControls): AgentTurnGeneration => {
  controls.reachNotAfter();
  return aborted;
};

/** A language model that is never asked: the turn client double answers instead. */
const TURN_MODEL: Extract<RoleModel, { specificationVersion: 'v4' }> = {
  specificationVersion: 'v4',
  provider: 'anthropic.messages',
  modelId: 'claude-haiku-5-5',
  supportedUrls: {},
  doGenerate: (): Promise<never> => Promise.reject(new Error('the turn client double answers the turn')),
  doStream: () => Promise.reject(new Error('a turn does not stream')),
};

interface Scenario {
  steps: Step[];
  counts?: TokenCountResult[];
  /** The ledger refuses the reservation: the task budget, or stopped or closed work (design-lifecycle.md, KD-2). */
  refuse?: 'task_tokens_exhausted' | 'stopping';
  notAfter?: Date;
  /** The investigation is cancelled before the turn is asked for. */
  cancelledBefore?: boolean;
}

interface Observed {
  result: AgentTurnResult;
  generateCalls: number;
  countCalls: number;
  reservations: ReservationRequest[];
  closings: Pick<ReservationClosing, 'callId' | 'status' | 'chargedTokens' | 'transcript'>[];
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
      if (scenario.refuse === 'stopping') return Promise.resolve({ outcome: 'stopping' });
      if (scenario.refuse !== undefined) {
        return Promise.resolve({ outcome: 'refused', code: scenario.refuse });
      }
      reservations.push(request);
      events.push('reserve');
      return Promise.resolve({ outcome: 'reserved', callId: `call-${reservations.length}` });
    },
    async close(_ctx, closing) {
      closings.push({
        callId: closing.callId,
        status: closing.status,
        chargedTokens: closing.chargedTokens,
        transcript: closing.transcript,
      });
      await closing.writeAnswer?.({} as never);
      events.push(`close:${closing.status}`);
      return 'closed';
    },
  };
  const turnClient: AgentTurnModelClient = {
    generateTurn() {
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
    countTurnInputTokens: () => {
      countCalls += 1;
      return Promise.resolve(counts.shift() ?? { outcome: 'counted', inputTokens: COUNTED });
    },
  };
  // Retry delays fire at once and are recorded; the `notAfter` timer, an hour away, fires only when a step reaches it.
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
    models: new Map([[HAIKU, TURN_MODEL]]),
    tokenCounter,
    catalog: DEFAULT_MODEL_CATALOG,
    clock,
    logger,
    ledger,
    turnClient,
  });
  const result = await gateway.turn({
    ctx: taskContext(controller.signal),
    agentName: 'worker',
    definition: { model: HAIKU, effort: 'low', maxOutputTokens: MAX_OUTPUT, marginTokens: MARGIN },
    promptVersion: PROMPT_VERSION,
    instructions: INSTRUCTIONS,
    messages: [{ role: 'user', content: 'Which service failed first?' }],
    tools: [],
    toolChoice: 'auto',
    inputLimitTokens: 100_000,
    transcriptInput: TRANSCRIPT_INPUT,
    notAfter: scenario.notAfter ?? IN_ONE_HOUR,
    busyWaitMs: 30_000,
    writeAnswer: () => {
      events.push('answer');
      return Promise.resolve();
    },
  });
  return { result, generateCalls, countCalls, reservations, closings, delays, events };
}

const failedClosings = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    callId: `call-${i + 1}`,
    status: 'failed' as const,
    chargedTokens: 0,
    transcript: { outcome: 'provider_error' as const, response: null },
  }));
/** The transcript input every reservation of the turn carries: the instructions and the view reference. */
const reservationOf: ReservationRequest = {
  role: 'agent',
  model: HAIKU,
  countedInputTokens: COUNTED,
  reservedTokens: RESERVED,
  transcript: { promptVersion: PROMPT_VERSION, input: TRANSCRIPT_INPUT },
};
const answeredTranscript = {
  outcome: 'answered',
  response: { object: { toolCalls: answer.toolCalls }, finishReason: 'tool-calls' },
} as const;
const modelUnavailable = { outcome: 'failed', code: 'model_unavailable', failureClass: 'transport_protocol' } as const;
const answered = { outcome: 'answered', answer: { callId: 'call-3', text: '', toolCalls: answer.toolCalls } } as const;

describe('ModelGateway retry policy', () => {
  it.each([
    ['statusCode 429', 429],
    ['statusCode 500', 500],
    ['statusCode 529', 529],
    ['a network error without statusCode', undefined],
  ])('retries %s twice, each request under its own reservation, then model_unavailable', async (_case, statusCode) => {
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
        result: answered,
        generateCalls: 3,
        reservations: [reservationOf, reservationOf, reservationOf],
        closings: [
          ...failedClosings(2),
          { callId: 'call-3', status: 'settled', chargedTokens: 1_200, transcript: answeredTranscript },
        ],
        events: ['reserve', 'close:failed', 'reserve', 'close:failed', 'reserve', 'answer', 'close:settled'],
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
          { outcome: 'failed', statusCode: 503, errorClass: 'api_error' },
          { outcome: 'failed', statusCode: null, errorClass: 'network_error' },
          { outcome: 'failed', statusCode: 500, errorClass: 'api_error' },
        ],
      },
      { result: modelUnavailable, generateCalls: 0, reservations: [], delays: [1_000, 3_000] },
    ],
    [
      'a request aborted by the cancel — no answer, no retry, the reservation left open',
      { steps: [cancelledThen(aborted), answer] },
      { result: { outcome: 'no_answer', reason: 'cancelled' }, generateCalls: 1, closings: [], events: ['reserve'] },
    ],
    [
      'a request interrupted at notAfter — no answer, no retry, the reservation left open',
      { steps: [interruptedAtNotAfter, answer] },
      { result: { outcome: 'no_answer', reason: 'deadline' }, generateCalls: 1, closings: [], events: ['reserve'] },
    ],
    [
      'an answer that resolves after the cancel — dropped, nothing written, nothing closed',
      { steps: [cancelledThen(answer)] },
      { result: { outcome: 'no_answer', reason: 'cancelled' }, generateCalls: 1, closings: [], events: ['reserve'] },
    ],
    [
      'the signal already aborted by a cancel — no count, no reservation, no request (invariant 4)',
      { steps: [answer], cancelledBefore: true },
      { result: { outcome: 'no_answer', reason: 'cancelled' }, generateCalls: 0, countCalls: 0, reservations: [] },
    ],
    [
      'notAfter already passed — no count, no reservation, no request',
      { steps: [answer], notAfter: NOW },
      { result: { outcome: 'no_answer', reason: 'deadline' }, generateCalls: 0, reservations: [] },
    ],
    [
      'a reservation refused with stopping — no answer as by a cancel, no request, nothing closed (KD-2)',
      { steps: [answer], refuse: 'stopping' },
      { result: { outcome: 'no_answer', reason: 'cancelled' }, generateCalls: 0, closings: [], delays: [] },
    ],
  ])('%s', async (_case, scenario, expected) => {
    const observed = await run(scenario);

    expect(observed).toMatchObject(expected);
  });
});
