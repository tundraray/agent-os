import type { Clock } from '@agent-os/runtime';
import { z } from 'zod';
import { DEFAULT_MODEL_CATALOG } from '../config/model-catalog.js';
import type { RoleModel } from '../ports.js';
import type { OutsideTaskClosing, OutsideTaskOpening, OutsideTaskTranscripts } from '../transcripts/transcript-writes.js';
import { type AssessAgentRequest, type AssessAgentResult, createAssessAgent } from './assess-agent.js';
import { createResultFormRegistry, type FormBindings, type ResultForm, TEXT_FORM } from './result-forms.js';
import { envelope } from './session-window.js';
import { BASE_TOOLS, createToolRegistry } from './tool-registry.js';
import { PROBE_RECORD_DETAIL_FORM } from '../../test/support/probe-forms.js';

// UC-14, DC-25 (design-agent-core.md, `Engine.assessAgent`): the turns of one definition outside an investigation —
// the prologue's `build`, turns with the investigation's view, tools and turn limit, `evaluate` on every `finish` — with
// the binding «table by the definition's fingerprint pair» replaced by the calibrating mark. No `collect`, `write` or
// forced end; no reserve and no token counter (the operation has no such port). Each turn writes one transcript of role
// `agent` with its whole input and the agent's name.
// Defects caught: a calibrated table used outside an investigation (a group where there must be none); a refusal that
// ends the operation instead of a new turn; a model call for a prologue `end`, for a definition that cannot be detached,
// for a model outside `assessModels`, after `notAfter` or for an input over 64 KiB; a transcript without the input or
// the agent's name.
// Boundary doubles: the language model (a `v4` model of the AI SDK specification) and the transcript port.

/** A language model of the current specification; ADR-0004 keeps the AI SDK and its test doubles out of src. */
type LanguageModel = Extract<RoleModel, { specificationVersion: 'v4' }>;

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const NOW = new Date('2026-11-08T10:00:00.000Z');
const TABLE = { pair: 'calibrated', group: 'A' };

const StatusSchema = z.strictObject({ status: z.enum(['supported', 'unsure']), group: z.string().nullable().optional() });

/**
 * The verifier-like form: a prologue that builds the claim message (or ends at once on `{ end: true }`), a closure that
 * refuses `unsure` and puts a group only from a calibrated table, never from the calibrating mark.
 */
const GROUPING_FORM: ResultForm = {
  name: 'probe_group',
  version: 1,
  resultSchema: StatusSchema,
  prologue: {
    firstMessageMaxBytes: 4_096,
    build: (input) =>
      typeof input === 'object' && input !== null && 'end' in input
        ? { kind: 'end', result: { status: 'supported' } }
        : { kind: 'start', firstMessage: `claim: ${JSON.stringify(input)}` },
  },
  closure: {
    evaluate: ({ result }, bindings: FormBindings) => {
      const parsed = StatusSchema.parse(result);
      if (parsed.status === 'unsure') return { kind: 'refuse', reason: 'status_unsure' };
      const table = bindings['groups'];
      const group = table?.kind === 'definition_pair_table' ? (table.value as typeof TABLE).group : null;
      return { kind: 'accept', result: { status: parsed.status, group } };
    },
    write: () => Promise.reject(new Error('write is never called outside an investigation')),
  },
  bindings: { groups: { kind: 'definition_pair_table', value: TABLE } },
};

/** A form whose closure reads the investigation: it cannot run outside one. */
const COLLECTING_FORM: ResultForm = {
  ...TEXT_FORM,
  name: 'probe_collect',
  closure: {
    collect: () => Promise.reject(new Error('collect is never called outside an investigation')),
    evaluate: ({ result }) => ({ kind: 'accept', result }),
    write: () => Promise.reject(new Error('write is never called outside an investigation')),
  },
};

const limits = {
  maxTurns: 3,
  maxCallsPerTurn: 1,
  maxChildren: 0,
  runTokens: 100_000,
  deadlineMs: 600_000,
  windowTokens: 50_000,
  marginTokens: 1_000,
  maxOutputTokens: 1_000,
};
const definition = (patch: Record<string, unknown>) => ({
  model: HAIKU,
  effort: 'low',
  prompt: 'Check the claim.',
  tools: [],
  result: 'probe_group',
  limits,
  ...patch,
});
const CONFIG = {
  processId: 'agent-probe',
  version: 1,
  goal: 'Check claims',
  sources: [],
  agents: {
    checker: definition({}),
    reader: definition({ tools: ['memory_read'], result: 'text' }),
    collector: definition({ result: 'probe_collect' }),
    outsider: definition({ model: SONNET }),
    recorder: definition({ result: 'probe_record' }),
  },
  rootAgent: 'checker',
  agentLimits: { maxDepth: 1 },
  limits: { investigationTokens: { default: 100_000, max: 100_000 }, maxTasks: 5, maxToolCalls: 5 },
  answer: { sections: ['summary'] },
};

/** A model whose answers are `finish` calls with these results, in order. */
function finishingModel(results: readonly unknown[]) {
  const answers = [...results];
  const observed = { calls: 0 };
  const model: LanguageModel = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    doGenerate: () => {
      observed.calls += 1;
      const result = answers.shift();
      return Promise.resolve({
        content: [{ type: 'tool-call', toolCallId: `c${observed.calls}`, toolName: 'finish', input: JSON.stringify(result) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      });
    },
    doStream: () => Promise.reject(new Error('a turn does not stream')),
  };
  return { model, observed };
}

interface Observed {
  readonly result: AssessAgentResult;
  readonly modelCalls: number;
  readonly opened: readonly OutsideTaskOpening[];
  readonly closed: readonly OutsideTaskClosing[];
}

async function assess(patch: Partial<AssessAgentRequest>, results: readonly unknown[] = [{ status: 'supported' }]): Promise<Observed> {
  const { model, observed } = finishingModel(results);
  const opened: OutsideTaskOpening[] = [];
  const closed: OutsideTaskClosing[] = [];
  const transcripts: OutsideTaskTranscripts = {
    open: (call) => {
      opened.push(call);
      return Promise.resolve(`transcript-${opened.length}`);
    },
    close: (_callId, closing) => {
      closed.push(closing);
      return Promise.resolve();
    },
  };
  const clock: Clock = { now: () => NOW, random: () => 0, setTimer: () => () => undefined };
  const assessAgent = createAssessAgent({
    models: new Map([[HAIKU, model]]),
    catalog: DEFAULT_MODEL_CATALOG,
    forms: createResultFormRegistry([TEXT_FORM, GROUPING_FORM, COLLECTING_FORM, PROBE_RECORD_DETAIL_FORM]),
    tools: createToolRegistry(BASE_TOOLS),
    clock,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    transcripts,
  });
  const result = await assessAgent({
    config: CONFIG,
    agentName: 'checker',
    prologueInput: { claim: 'the job fails on a full disk' },
    deploymentEntries: [{ id: 'd1', text: 'Cite the record.' }],
    binding: { selfCheckRunId: 'run-1' },
    notAfter: new Date(NOW.getTime() + 60_000),
    ...patch,
  });
  return { result, modelCalls: observed.calls, opened, closed };
}

const usageOf = (turns: number) => ({
  inputTokens: 100 * turns,
  outputTokens: 10 * turns,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: expect.any(Number) as unknown as number,
});

describe('assessAgent по UC-14', () => {
  it.each<[string, Partial<AssessAgentRequest>, readonly unknown[], AssessAgentResult, number]>([
    [
      'a result without a group although the form binds a calibrated table',
      {},
      [{ status: 'supported' }],
      { outcome: 'finished', result: { status: 'supported', group: null }, usage: usageOf(1) },
      1,
    ],
    [
      'invalid_result and a new turn, then the accepted result',
      {},
      [{ status: 'unsure' }, { status: 'supported' }],
      { outcome: 'finished', result: { status: 'supported', group: null }, usage: usageOf(2) },
      2,
    ],
    ['every turn refused: invalid_result', {}, [{ status: 'unsure' }, { status: 'unsure' }, { status: 'unsure' }], { outcome: 'invalid_result', usage: usageOf(3) }, 3],
    ['the prologue ends at once: ended, no model call', { prologueInput: { end: true } }, [], { outcome: 'ended', result: { status: 'supported', group: null }, usage: usageOf(0) }, 0],
    ['tools besides finish: agent_not_detachable', { agentName: 'reader' }, [], { outcome: 'rejected', code: 'agent_not_detachable' }, 0],
    ['a closure with collect: agent_not_detachable', { agentName: 'collector' }, [], { outcome: 'rejected', code: 'agent_not_detachable' }, 0],
    ['a model outside assessModels: model_unavailable, no model call', { agentName: 'outsider' }, [], { outcome: 'rejected', code: 'model_unavailable' }, 0],
    ['a notAfter already past: not_after, no model call', { notAfter: NOW }, [], { outcome: 'failed', code: 'not_after', usage: usageOf(0) }, 0],
    [
      // Fix cycle 1 (D9), DC-30: a view that does not fit the window even at stage 4 is not sent.
      'a view over the window at stage 4: context_overflow, no model call',
      { config: { ...CONFIG, agents: { ...CONFIG.agents, checker: definition({ limits: { ...limits, windowTokens: 1_100 } }) } } },
      [],
      { outcome: 'failed', code: 'context_overflow', usage: usageOf(0) },
      0,
    ],
    [
      'an input over 64 KiB: prologue_oversize, no model call',
      { prologueInput: { claim: 'x'.repeat(65_536) } },
      [],
      { outcome: 'failed', code: 'prologue_oversize', usage: usageOf(0) },
      0,
    ],
  ])('%s', async (_case, patch, results, expected, modelCalls) => {
    const observed = await assess(patch, results);

    expect(observed.result).toEqual(expected);
    expect(observed.modelCalls).toBe(modelCalls);
    expect(observed.opened).toHaveLength(modelCalls);
  });

  // DC-20. Defect caught: the notice of a refused `finish` carries only the reason, so the next turn has no `detail`.
  it('a refusal with detail: the next turn reads the same detail, and the result has no group', async () => {
    const observed = await assess({ agentName: 'recorder', prologueInput: { assignment: { task: 'the probe task' } } }, [{ note: 'first', refuse: true }, { note: 'second' }]);

    expect(observed.result).toEqual({ outcome: 'finished', result: { note: 'second' }, usage: usageOf(2) });
    expect(observed.opened[1]?.opening.input).toMatchObject({
      messages: [
        { role: 'user' },
        { role: 'assistant' },
        {
          role: 'tool',
          results: [
            {
              toolCallId: 'c1',
              toolName: 'finish',
              output: envelope(
                'tool finish',
                'engine',
                '{"outcome":"rejected","reason":"invalid_result: refused_by_probe","detail":{"reason":"refused_by_probe","detail":{"missing":"the probe field","attempt":1}}}',
              ),
            },
          ],
        },
      ],
    });
  });

  it('writes a transcript of role agent per turn with the whole input and the agent name', async () => {
    const observed = await assess({});

    expect(observed.opened).toEqual([
      {
        role: 'agent',
        model: HAIKU,
        binding: { selfCheckRunId: 'run-1' },
        agentName: 'checker',
        opening: {
          promptVersion: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown as string,
          input: {
            instructions: expect.stringContaining('Check the claim.\n\n') as unknown as string,
            messages: [{ role: 'user', content: envelope('prologue', 'engine', 'claim: {"claim":"the job fails on a full disk"}') }],
          },
        },
      },
    ]);
    const [opened] = observed.opened;
    expect(opened?.opening.input).toMatchObject({ instructions: expect.stringMatching(/Cite the record\.$/) as unknown as string });
    expect(observed.closed.map((closing) => closing.transcript.outcome)).toEqual(['answered']);
  });
});
