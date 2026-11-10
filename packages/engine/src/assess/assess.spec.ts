import type { Clock } from '@agent-os/runtime';
import { z } from 'zod';
import { AgentProcessConfigSchema } from '../config/agent-config.schema.js';
import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import { promptVersion } from '../model/prompt-version.js';
import type { RoleCall, RoleGeneration, RoleModelClient } from '../model/role-agent.js';
import type { EngineLogger, RoleModel } from '../ports.js';
import { deepResearchProcessV3 } from '../processes/shipped-processes.js';
import type {
  OutsideTaskClosing,
  OutsideTaskOpening,
  OutsideTaskTranscripts,
} from '../transcripts/transcript-writes.js';
import { type AssessBinding, type AssessRequest, type AssessResult, createAssess } from './assess.js';

// design-self-check.md, Contract Definitions `Engine.assess` and `createEngine`; DC-3 (the rule half), NFR-02.
// `assess` calls only a model the assembly point allowed, retries by the rules of ModelGateway (two after a provider
// error, one after an answer off the schema) and writes one transcript per attempt with the caller's role and binding;
// its prompt version is the fingerprint of the instructions as they are.
// Defects caught: a judge call that reaches the provider past the model list; an attempt without a transcript, or one
// bound to nothing; retry counts that drift from ModelGateway; a version taken from trimmed instructions.
// The retry rules themselves are proven in retry-policy.spec.ts and are not repeated here.
// Boundary doubles: the model client, the transcript writes and the clock.

const NOW = new Date('2026-11-07T10:00:00.000Z');
const IN_ONE_HOUR = new Date(NOW.getTime() + 3_600_000);
const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const RUN_ID = 'self-check:run:0001';
const INVESTIGATION_ID = '00000000-0000-4000-8000-000000000002';

const VerdictSchema = z.object({ verdict: z.enum(['pass', 'fail']) });
type Verdict = z.infer<typeof VerdictSchema>;

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
});
const answer: RoleGeneration = {
  finishReason: 'stop',
  object: { verdict: 'pass' },
  text: '',
  usage: usage(1_000, 100),
};
const invalid: RoleGeneration = {
  finishReason: 'stop',
  object: { verdict: 'maybe' },
  text: '',
  usage: usage(1_000, 50),
};
/** A judge answer the provider's filter stopped: the object parses, and it is still no verdict. */
const filtered: RoleGeneration = { ...answer, finishReason: 'content-filter' };
const apiError = (statusCode: number): Error =>
  Object.assign(new Error('provider error'), { name: 'AI_APICallError', statusCode });

type Step = RoleGeneration | Error;

interface Harness {
  assess(overrides?: Partial<AssessRequest<Verdict>>): Promise<AssessResult<Verdict>>;
  calls: RoleCall<unknown>[];
  opened: OutsideTaskOpening[];
  closed: { callId: string; closing: OutsideTaskClosing }[];
  delays: number[];
}

function harness(steps: Step[], now: Date = NOW): Harness {
  const remaining = [...steps];
  const observed: Omit<Harness, 'assess'> = { calls: [], opened: [], closed: [], delays: [] };
  const client: RoleModelClient = {
    generate(call) {
      observed.calls.push(call);
      const step = remaining.shift();
      if (step === undefined) throw new Error('the scenario has no more model steps');
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  const transcripts: OutsideTaskTranscripts = {
    open(call) {
      observed.opened.push(call);
      return Promise.resolve(`call-${observed.opened.length}`);
    },
    close(callId, closing) {
      observed.closed.push({ callId, closing });
      return Promise.resolve();
    },
  };
  // Retry delays fire at once and are recorded.
  const clock: Clock = {
    now: () => now,
    random: () => 0,
    setTimer: (ms, callback) => {
      observed.delays.push(ms);
      queueMicrotask(callback);
      return () => {};
    },
  };
  const logger: EngineLogger = { log: () => {}, warn: () => {}, error: () => {} };
  const assess = createAssess({
    models: new Map([[HAIKU, { modelId: HAIKU } as unknown as RoleModel]]),
    catalog: DEFAULT_MODEL_CATALOG,
    clock,
    logger,
    transcripts,
    client,
  });
  return {
    ...observed,
    assess: (overrides = {}) =>
      assess({
        role: 'judge',
        model: HAIKU,
        effort: 'low',
        maxOutputTokens: 2_000,
        instructions: 'Judge the answer against the scenario key.',
        messages: [{ role: 'user', content: 'answer and key' }],
        outputSchema: VerdictSchema,
        binding: { selfCheckRunId: RUN_ID },
        notAfter: IN_ONE_HOUR,
        ...overrides,
      }),
  };
}

/** Spend as the Haiku catalog prices it: $0.1 per million input tokens, $0.5 per million output tokens. */
const spend = (inputTokens: number, outputTokens: number, costUsd: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: expect.closeTo(costUsd, 12) as number,
});

describe('assess', () => {
  it.each<{
    name: string;
    steps: Step[];
    overrides?: Partial<AssessRequest<Verdict>>;
    now?: Date;
    outcome: AssessResult<Verdict>;
    providerCalls: number;
    closedOutcomes: string[];
    delays: number[];
  }>([
    {
      name: 'a model outside the allowed list is model_unavailable without a provider call or a transcript',
      steps: [answer],
      overrides: { model: SONNET },
      outcome: {
        outcome: 'failed',
        code: 'model_unavailable',
        usage: spend(0, 0, 0),
      },
      providerCalls: 0,
      closedOutcomes: [],
      delays: [],
    },
    {
      name: 'an answer on the schema is answered with its spend',
      steps: [answer],
      outcome: {
        outcome: 'answered',
        output: { verdict: 'pass' },
        usage: spend(1_000, 100, 0.00015),
      },
      providerCalls: 1,
      closedOutcomes: ['answered'],
      delays: [],
    },
    {
      name: 'an answer off the schema is retried once, then invalid_output with the spend of both attempts',
      steps: [invalid, invalid, answer],
      outcome: {
        outcome: 'invalid_output',
        usage: spend(2_000, 100, 0.00025),
      },
      providerCalls: 2,
      closedOutcomes: ['invalid_output', 'invalid_output'],
      delays: [],
    },
    {
      // G1: `content-filter` is a refusal (classifyResolution), not a verdict, even when the object is on the schema.
      name: 'an answer stopped by the content filter is not a verdict: retried once, then invalid_output',
      steps: [filtered, filtered, answer],
      outcome: {
        outcome: 'invalid_output',
        usage: spend(2_000, 200, 0.0003),
      },
      providerCalls: 2,
      closedOutcomes: ['invalid_output', 'invalid_output'],
      delays: [],
    },
    {
      name: 'a provider error is retried twice, then failed model_unavailable',
      steps: [apiError(529), apiError(500), apiError(429), answer],
      outcome: {
        outcome: 'failed',
        code: 'model_unavailable',
        usage: spend(0, 0, 0),
      },
      providerCalls: 3,
      closedOutcomes: ['provider_error', 'provider_error', 'provider_error'],
      delays: [1_000, 3_000],
    },
    {
      name: 'a provider error that is not retryable fails at once',
      steps: [apiError(400), answer],
      outcome: {
        outcome: 'failed',
        code: 'model_unavailable',
        usage: spend(0, 0, 0),
      },
      providerCalls: 1,
      closedOutcomes: ['provider_error'],
      delays: [],
    },
    {
      name: 'no attempt starts at notAfter',
      steps: [answer],
      now: IN_ONE_HOUR,
      outcome: {
        outcome: 'failed',
        code: 'model_unavailable',
        usage: spend(0, 0, 0),
      },
      providerCalls: 0,
      closedOutcomes: [],
      delays: [],
    },
  ])('$name', async ({ steps, overrides, now, outcome, providerCalls, closedOutcomes, delays }) => {
    const observed = harness(steps, now);

    expect(await observed.assess(overrides)).toEqual(outcome);
    expect(observed.calls).toHaveLength(providerCalls);
    expect(observed.closed.map(({ closing }) => closing.transcript.outcome)).toEqual(closedOutcomes);
    expect(observed.delays).toEqual(delays);
  });

  it.each<{ name: string; binding: AssessBinding; role: AssessRequest<Verdict>['role'] }>([
    { name: 'a judge call bound to a self-check run', binding: { selfCheckRunId: RUN_ID }, role: 'judge' },
    { name: 'a judge call bound to an investigation', binding: { investigationId: INVESTIGATION_ID }, role: 'judge' },
  ])('writes one transcript per attempt with the role and binding of the request: $name', async ({ binding, role }) => {
    const observed = harness([invalid, answer]);

    expect((await observed.assess({ binding, role })).outcome).toBe('answered');
    expect(observed.opened.map((call) => ({ role: call.role, model: call.model, binding: call.binding }))).toEqual([
      { role, model: HAIKU, binding },
      { role, model: HAIKU, binding },
    ]);
    expect(observed.closed.map(({ callId }) => callId)).toEqual(['call-1', 'call-2']);
    expect(observed.opened[0]?.opening.input).toEqual({
      instructions: 'Judge the answer against the scenario key.',
      messages: [{ role: 'user', content: 'answer and key' }],
    });
  });

  it.each<{ name: string; binding: unknown }>([
    { name: 'an empty binding', binding: {} },
    { name: 'empty identifiers', binding: { investigationId: '', selfCheckRunId: '' } },
  ])('rejects a request without binding before any write or call: $name', async ({ binding }) => {
    const observed = harness([answer]);

    await expect(observed.assess({ binding: binding as AssessBinding })).rejects.toThrow(
      'investigationId or a selfCheckRunId',
    );
    expect(observed.opened).toEqual([]);
    expect(observed.calls).toEqual([]);
  });

  it('versions the instructions as they are: the checker template gives its version, a trailing space another', async () => {
    const template = AgentProcessConfigSchema.parse(deepResearchProcessV3).agents.verifier?.prompt;
    if (template === undefined) throw new Error('the shipped configuration has no verifier');

    const exact = harness([answer]);
    const trailingSpace = harness([answer]);
    await exact.assess({ role: 'judge', instructions: template });
    await trailingSpace.assess({ role: 'judge', instructions: `${template} ` });

    expect(exact.opened[0]?.opening.promptVersion).toBe(promptVersion(template));
    expect(trailingSpace.opened[0]?.opening.promptVersion).not.toBe(promptVersion(template));
    expect(trailingSpace.opened[0]?.opening.promptVersion).toMatch(/^[0-9a-f]{12}$/);
  });
});
