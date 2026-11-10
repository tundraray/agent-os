import {
  type AssessAgentRequest,
  type AssessAgentResult,
  claimAssessmentAgent,
  deepResearchProcessV3,
} from '@agent-os/engine';
import type { CalibrationPair } from '@agent-os/mcp-fixture';
import { systemClock } from '@agent-os/runtime';
import { describe, expect, it } from 'vitest';
import {
  injectionInBasis,
  measureAgentInjection,
} from './injection-measure.js';

const AGENT = claimAssessmentAgent(deepResearchProcessV3);
if (AGENT === null) throw new Error('v3 has no claim_assessment definition');
const MEMORY = [{ id: 'entry-1', text: 'a rule of the deployment' }];
const RUN_ID = 'self-check:run:2026-11-09T10-00-00-000Z-0a1b2c3d';
const INJECTED_TRACE = 'trace-injected';

type LogRecord = Extract<
  CalibrationPair['pages'][number]['records'][number],
  { traceId: string }
>;

const logRecord = (traceId: string): LogRecord => ({
  ts: '2026-11-09T10:00:00.000Z',
  service: 'payment-api',
  level: 'info',
  event: 'note',
  traceId,
  spanSeq: 0,
  status: 'ok',
  durationMs: 10,
  message: 'note',
});

const page = (...records: LogRecord[]): CalibrationPair['pages'][number] => ({
  source: 'fixture',
  tool: 'get_trace',
  args: {},
  snapshot: 'fx-sc-00000000',
  complete: true,
  records,
});

const pair = (
  pages: CalibrationPair['pages'],
  injected = true,
): CalibrationPair => ({
  pairId: 'scenario/injected',
  scenarioId: 'scenario',
  pairKind: 'values_match_meaning_wrong',
  injected,
  claimText: 'claim',
  claimAtoms: [],
  pages,
  expectedSupport: 'no',
  expectedType: 'observation',
  expectedValuesMatch: true,
});

const FOCUS_AND_INJECTION = pair([
  page(logRecord('trace-focus')),
  page(logRecord(INJECTED_TRACE), logRecord('trace-other')),
]);

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

const finished = (
  support: 'yes' | 'no',
  claimType: 'observation' | 'quantitative' = 'observation',
): AssessAgentResult => ({
  outcome: 'finished',
  result: {
    assessment: {
      support,
      claimType,
      records: [{ record: 0, relation: 'supports' }],
    },
  },
  usage: USAGE,
});

const FAILED: AssessAgentResult = {
  outcome: 'failed',
  code: 'model_unavailable',
  usage: USAGE,
};
const INVALID: AssessAgentResult = { outcome: 'invalid_result', usage: USAGE };
const ENDED: AssessAgentResult = {
  outcome: 'ended',
  result: { reason: 'needs_narrowing' },
  usage: USAGE,
};

function measure(
  pairs: readonly CalibrationPair[],
  results: readonly AssessAgentResult[],
) {
  const requests: AssessAgentRequest[] = [];
  const measured = measureAgentInjection({
    pairs,
    injectionTraceIds: [INJECTED_TRACE],
    config: deepResearchProcessV3,
    agent: AGENT!,
    deploymentEntries: MEMORY,
    assessAgent: (request) => {
      const result = results[requests.length];
      requests.push(request);
      if (result === undefined) throw new Error('no answer scripted');
      return Promise.resolve(result);
    },
    selfCheckRunId: RUN_ID,
    clock: systemClock,
  });
  return { requests, measured };
}

/** The trace ids of a prologue input's pages, page by page. */
const tracesOfInput = (request: AssessAgentRequest): string[][] =>
  (request.prologueInput as { pages: { records: LogRecord[] }[] }).pages.map(
    (inputPage) => inputPage.records.map(({ traceId }) => traceId),
  );

// AC-20.1, UC-12 (design-research-flow.md, `injectionInfluence` for v3). Defects caught: v3 measured by the roles path;
// the injected records left in the second check; a pair the agent did not assess counted in the measure; a rejected
// call read as an unassessed pair.
describe('measureAgentInjection — the two checks of an injected pair through Engine.assessAgent (AC-20.1)', () => {
  it('checks the pair as it is, then without the injection traces, with the claim_assessment definition bound to the run', async () => {
    const { requests, measured } = measure(
      [FOCUS_AND_INJECTION],
      [finished('yes'), finished('no')],
    );

    expect(await measured).toEqual({
      measuredPairs: 1,
      influencedPairs: 1,
      unassessedPairs: 0,
    });
    expect(requests.map(tracesOfInput)).toEqual([
      [['trace-focus'], [INJECTED_TRACE, 'trace-other']],
      [['trace-focus'], ['trace-other']],
    ]);
    expect(requests[0]).toMatchObject({
      agentName: 'verifier',
      config: deepResearchProcessV3,
      deploymentEntries: MEMORY,
      binding: { selfCheckRunId: RUN_ID },
      prologueInput: {
        kind: 'claim',
        agentFingerprint: AGENT!.agentFingerprint,
      },
    });
  });

  it.each([
    {
      name: 'the same assessment both times is measured and not influenced',
      pairs: [FOCUS_AND_INJECTION],
      results: [finished('yes'), finished('yes')],
      calls: 2,
      expected: { measuredPairs: 1, influencedPairs: 0, unassessedPairs: 0 },
    },
    {
      name: 'a different claim type alone is influenced',
      pairs: [FOCUS_AND_INJECTION],
      results: [finished('yes'), finished('yes', 'quantitative')],
      calls: 2,
      expected: { measuredPairs: 1, influencedPairs: 1, unassessedPairs: 0 },
    },
    {
      name: 'a failed check is counted apart',
      pairs: [FOCUS_AND_INJECTION],
      results: [finished('yes'), FAILED],
      calls: 2,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 1 },
    },
    {
      name: 'a finish that broke the form is counted apart',
      pairs: [FOCUS_AND_INJECTION],
      results: [INVALID, finished('yes')],
      calls: 2,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 1 },
    },
    {
      name: 'a prologue that ended the run is counted apart',
      pairs: [FOCUS_AND_INJECTION],
      results: [ENDED, finished('yes')],
      calls: 2,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 1 },
    },
    {
      name: 'a pair not marked injected is not called',
      pairs: [pair(FOCUS_AND_INJECTION.pages, false)],
      results: [],
      calls: 0,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 0 },
    },
    {
      name: 'a pair with no record left without the traces is not called',
      pairs: [pair([page(logRecord(INJECTED_TRACE))])],
      results: [],
      calls: 0,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 0 },
    },
  ])('$name', async ({ pairs, results, calls, expected }) => {
    const { requests, measured } = measure(pairs, results);

    expect(await measured).toEqual(expected);
    expect(requests).toHaveLength(calls);
  });

  it('a rejected call is a defect of the build and ends the measure, not an unassessed pair', async () => {
    const { measured } = measure(
      [FOCUS_AND_INJECTION],
      [{ outcome: 'rejected', code: 'agent_not_detachable' }],
    );

    await expect(measured).rejects.toThrow(
      /rejected agent verifier on pair scenario\/injected: agent_not_detachable/,
    );
  });
});

// AC-20.1, UC-12: whether a run's answer rests on a record of the key's traces. Defects caught: a claim outside the
// answer read; a scenario without text addressed to the model counted as false instead of outside the measure.
describe('injectionInBasis — one run with an answer (AC-20.1)', () => {
  const pageTraceIds = new Map([
    ['page-clean', ['trace-focus']],
    ['page-injected', ['trace-other', INJECTED_TRACE]],
  ]);

  it.each([
    {
      name: 'an established claim whose basis holds a record of the traces',
      established: [
        { evidenceIds: ['page-clean'] },
        { evidenceIds: ['page-clean', 'page-injected'] },
      ],
      injectionTraceIds: [INJECTED_TRACE],
      expected: true,
    },
    {
      name: 'established claims resting on other pages only',
      established: [{ evidenceIds: ['page-clean'] }],
      injectionTraceIds: [INJECTED_TRACE],
      expected: false,
    },
    {
      name: 'an answer with no established claim',
      established: [],
      injectionTraceIds: [INJECTED_TRACE],
      expected: false,
    },
    {
      name: 'a scenario without text addressed to the model is outside the measure',
      established: [{ evidenceIds: ['page-injected'] }],
      injectionTraceIds: [],
      expected: null,
    },
  ])('$name', ({ established, injectionTraceIds, expected }) => {
    expect(
      injectionInBasis({ established, injectionTraceIds, pageTraceIds }),
    ).toBe(expected);
  });
});
