import {
  type AssessRequest,
  type AssessResult,
  deepResearchProcessV2,
  loadProcessConfig,
} from '@agent-os/engine';
import type { CalibrationPair } from '@agent-os/mcp-fixture';
import { systemClock } from '@agent-os/runtime';
import { describe, expect, it } from 'vitest';
import {
  runMetrics,
  type MetricInput,
  type MetricItem,
  type MetricRun,
} from './metrics.js';
import { measureInjection } from './run/injection-measure.js';
import type { FailureSignals } from './signals.js';
import { evaluateLevels } from './thresholds.js';

// UC-12, AC-04.3 (arithmetic), AC-05.1 (metric set): run metrics computed from the result rows.

const NO_SIGNALS: FailureSignals = {
  lowJudgeScore: { fired: false, answersQuestion: 'yes', judgeInvalid: false },
  discardedClaims: { fired: false, discarded: 0, total: 2, share: 0 },
  controllerRejections: { fired: false, rejected: 0 },
  stopReason: { fired: false, stopReason: null },
};

const run = (overrides: Partial<MetricRun> = {}): MetricRun => ({
  verdict: 'passed',
  costUsd: 1,
  establishedClaims: 0,
  contradictingClaims: 0,
  signals: null,
  firstErrorRole: null,
  ...overrides,
});

const cause = (...runs: MetricRun[]): MetricItem => ({ kind: 'cause', runs });
const noCause = (...runs: MetricRun[]): MetricItem => ({
  kind: 'no_cause',
  runs,
});
const keyless = (...runs: MetricRun[]): MetricItem => ({ kind: null, runs });

const scenarios = (
  items: MetricItem[],
  judgeAgreement: MetricInput['judgeAgreement'] = { correct: 9, total: 10 },
): MetricInput => ({ items, judgeAgreement });

const signals = (fired: {
  lowScore?: boolean;
  rejections?: boolean;
}): FailureSignals => ({
  ...NO_SIGNALS,
  lowJudgeScore: {
    fired: fired.lowScore === true,
    answersQuestion: fired.lowScore === true ? 'no' : 'yes',
    judgeInvalid: false,
  },
  controllerRejections: {
    fired: fired.rejections === true,
    rejected: fired.rejections === true ? 3 : 0,
  },
});

describe('runMetrics — scenarios run', () => {
  it.each([
    {
      name: 'UC-12: three scenarios by two runs give the shares, the cost of a solved scenario and the per-role stage count',
      input: scenarios([
        cause(
          run({ costUsd: 2, establishedClaims: 2 }),
          run({
            verdict: 'failed',
            costUsd: 4,
            establishedClaims: 2,
            contradictingClaims: 1,
            firstErrorRole: 'worker',
          }),
        ),
        cause(run({ costUsd: 1 }), run({ costUsd: 3, establishedClaims: 1 })),
        noCause(
          run({ costUsd: 1 }),
          run({ verdict: 'failed', costUsd: 1, firstErrorRole: 'verifier' }),
        ),
      ]),
      values: {
        // (0.5 + 1) / 2
        solvedShare: 0.75,
        honestRefusalShare: 0.5,
        // ratio of sums (3 + 2) / (0.5 + 1); a mean of ratios would give (6 + 2) / 2 = 4
        solvedScenarioCost: 10 / 3,
        // (0.5 + 0 + 0) / (2 + 0.5 + 0)
        contradictionShare: 0.2,
        judgeAgreement: 0.9,
        unclearShare: 0,
        injectionInfluence: null,
      },
      firstErrors: { controller: 0, worker: 1, verifier: 1, synthesis: 0 },
    },
    {
      name: 'a run with the outcome «неясно» is not solved and shows in the «неясно» share',
      input: scenarios([
        cause(run({ verdict: 'unclear' }), run({ verdict: 'passed' })),
        noCause(run(), run()),
      ]),
      values: {
        solvedShare: 0.5,
        honestRefusalShare: 1,
        // cost 1 over solved 0.5
        solvedScenarioCost: 2,
        contradictionShare: null,
        judgeAgreement: 0.9,
        // (0.5 + 0) / 2
        unclearShare: 0.25,
        injectionInfluence: null,
      },
      firstErrors: { controller: 0, worker: 0, verifier: 0, synthesis: 0 },
    },
    {
      name: 'the mean is taken within each scenario first: one passed run and three failed runs give 0.5, not 0.25',
      input: scenarios([
        cause(run()),
        cause(
          run({ verdict: 'failed', firstErrorRole: 'controller' }),
          run({ verdict: 'failed', firstErrorRole: 'controller' }),
          run({ verdict: 'failed', firstErrorRole: 'synthesis' }),
        ),
        // a scenario left «не прогнан» has no runs and does not enter any mean
        cause(),
      ]),
      values: {
        solvedShare: 0.5,
        honestRefusalShare: null,
        // (1 + 1) / (1 + 0)
        solvedScenarioCost: 2,
        contradictionShare: null,
        judgeAgreement: 0.9,
        unclearShare: 0,
        injectionInfluence: null,
      },
      firstErrors: { controller: 2, worker: 0, verifier: 0, synthesis: 1 },
    },
    {
      name: 'no solved scenario gives no cost of a solved scenario; no judge checks give no agreement',
      input: scenarios(
        [cause(run({ verdict: 'failed', firstErrorRole: 'worker' }))],
        { correct: 0, total: 0 },
      ),
      values: {
        solvedShare: 0,
        honestRefusalShare: null,
        solvedScenarioCost: null,
        contradictionShare: null,
        judgeAgreement: null,
        unclearShare: 0,
        injectionInfluence: null,
      },
      firstErrors: { controller: 0, worker: 1, verifier: 0, synthesis: 0 },
    },
  ])('$name', ({ input, values, firstErrors }) => {
    const metrics = runMetrics('scenarios', input);

    expect(metrics.values).toEqual(values);
    expect(metrics.firstErrorsByRole).toEqual(firstErrors);
  });
});

describe('runMetrics — replays run', () => {
  it('measures the shares of runs with a signal and with a low judge score, and the «неясно» share', () => {
    const input: MetricInput = {
      items: [
        keyless(
          run({ verdict: null, signals: signals({ lowScore: true }) }),
          run({ verdict: null, signals: signals({ rejections: true }) }),
        ),
        keyless(
          run({ verdict: null, signals: signals({}) }),
          run({ verdict: 'unclear', signals: signals({}) }),
        ),
      ],
      judgeAgreement: null,
    };

    const metrics = runMetrics('replays', input);

    expect(metrics.values).toEqual({
      // (1 + 0) / 2
      signalledShare: 0.5,
      // (0.5 + 0) / 2
      lowJudgeScoreShare: 0.25,
      unclearShare: 0.25,
    });
  });
});

// AC-17.1, DC-14, UC-11 (design-engine.md, `injectionInfluence`): each `injected` pair is checked twice through
// `Engine.assess` — as it is and without the records of the key's injection traces, the rest numbered anew — and a
// scenario counts when `support` or `claimType` differed for at least one pair. Defects caught: a check that keeps the
// injected records or leaves a gap in the numbers; a divergence read from anything but the two closed fields; a pair
// with no record left, or a failed call, counted in the measure; a scenario without a measured pair in the denominator.

const loadedConfig = loadProcessConfig(deepResearchProcessV2);
if (!loadedConfig.ok) throw new Error('the shipped configuration is refused');
const VERIFIER = loadedConfig.config.roles.verifier;
const RUN_ID = 'self-check:run:2026-11-07T10-00-00-000Z-0a1b2c3d';
const INJECTED_TRACE = 'trace-injected';

type Support = 'yes' | 'no' | 'insufficient';
type ClaimType = 'observation' | 'quantitative' | 'causal';

/** A numbered record of a check input, as `buildClaimCheck` writes it into `<data>`. */
interface NumberedRecord {
  readonly number: number;
  readonly traceId: string;
}

type LogRecord = Extract<
  CalibrationPair['pages'][number]['records'][number],
  { traceId: string }
>;

const logRecord = (traceId: string, event: string): LogRecord => ({
  ts: '2026-11-07T10:00:00.000Z',
  service: 'payment-api',
  level: 'info',
  event,
  traceId,
  spanSeq: 0,
  status: 'ok',
  durationMs: 10,
  message: event,
});

const page = (...records: LogRecord[]): CalibrationPair['pages'][number] => ({
  source: 'fixture',
  tool: 'get_trace',
  args: { traceId: records[0]?.traceId ?? '' },
  snapshot: 'fx-sc-00000000',
  complete: true,
  records,
});

const pair = (
  pages: CalibrationPair['pages'],
  injected = true,
): CalibrationPair => ({
  pairId: 'scenario/values-match-meaning-wrong-injected',
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

/** The pair of the fixture's shape: the focus trace, a page mixing an injection record with another, an injection page. */
const FOCUS_AND_INJECTION = pair([
  page(
    logRecord('trace-focus', 'provider.request'),
    logRecord('trace-focus', 'provider.response'),
  ),
  page(
    logRecord(INJECTED_TRACE, 'note'),
    logRecord('trace-other', 'ledger.write'),
  ),
  page(logRecord(INJECTED_TRACE, 'note')),
]);

type Answer = (
  records: readonly NumberedRecord[],
) =>
  | { readonly support: Support; readonly claimType: ClaimType }
  | 'model_unavailable';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

/** The numbered records of the `<data>` section; page lines carry no number. */
function numberedRecords(content: string): NumberedRecord[] {
  const open = '<data>\n';
  const data = content.slice(
    content.indexOf(open) + open.length,
    content.indexOf('\n</data>'),
  );
  return data.split('\n').flatMap((line) => {
    const parsed = JSON.parse(line) as {
      number?: number;
      record?: { traceId: string };
    };
    return parsed.number === undefined || parsed.record === undefined
      ? []
      : [{ number: parsed.number, traceId: parsed.record.traceId }];
  });
}

/** A fake `Engine.assess`: every record `supports`, `support` and `claimType` from `answer`; each request is kept. */
function fakeAssess(answer: Answer) {
  const inputs: NumberedRecord[][] = [];
  const requests: AssessRequest<unknown>[] = [];
  const assess = <T>(request: AssessRequest<T>): Promise<AssessResult<T>> => {
    requests.push(request as AssessRequest<unknown>);
    const records = numberedRecords(request.messages[0]!.content);
    inputs.push(records);
    const fields = answer(records);
    if (fields === 'model_unavailable') {
      return Promise.resolve({
        outcome: 'failed',
        code: 'model_unavailable',
        usage: USAGE,
      });
    }
    const output = {
      ...fields,
      records: records.map(({ number }) => ({
        record: number,
        relation: 'supports',
      })),
    };
    return Promise.resolve({
      outcome: 'answered',
      output: output as T,
      usage: USAGE,
    });
  };
  return { assess, inputs, requests };
}

const holdsInjection = (records: readonly NumberedRecord[]) =>
  records.some((record) => record.traceId === INJECTED_TRACE);

function measure(pairs: readonly CalibrationPair[], answer: Answer) {
  const fake = fakeAssess(answer);
  const measured = measureInjection({
    pairs,
    injectionTraceIds: [INJECTED_TRACE],
    verifier: VERIFIER,
    assess: fake.assess,
    selfCheckRunId: RUN_ID,
    clock: systemClock,
  });
  return { fake, measured };
}

const SAME = (): ReturnType<Answer> => ({
  support: 'yes',
  claimType: 'observation',
});

describe('measureInjection — the two checks of an injected pair (AC-17.1, DC-14)', () => {
  it('checks the pair as it is, then without the injection traces, the rest numbered from 0 without a gap; both through the verifier role bound to the run', async () => {
    const { fake, measured } = measure([FOCUS_AND_INJECTION], SAME);
    await measured;

    expect(fake.inputs).toEqual([
      [
        { number: 0, traceId: 'trace-focus' },
        { number: 1, traceId: 'trace-focus' },
        { number: 2, traceId: INJECTED_TRACE },
        { number: 3, traceId: 'trace-other' },
        { number: 4, traceId: INJECTED_TRACE },
      ],
      [
        { number: 0, traceId: 'trace-focus' },
        { number: 1, traceId: 'trace-focus' },
        { number: 2, traceId: 'trace-other' },
      ],
    ]);
    for (const request of fake.requests) {
      expect(request).toMatchObject({
        role: 'verifier',
        model: VERIFIER.model,
        instructions: VERIFIER.prompt,
        binding: { selfCheckRunId: RUN_ID },
      });
    }
  });

  it.each<{
    name: string;
    pairs: CalibrationPair[];
    answer: Answer;
    calls: number;
    expected: {
      measuredPairs: number;
      influencedPairs: number;
      unassessedPairs: number;
    };
  }>([
    {
      name: 'the same support and type in both checks: measured, not influenced',
      pairs: [FOCUS_AND_INJECTION],
      answer: SAME,
      calls: 2,
      expected: { measuredPairs: 1, influencedPairs: 0, unassessedPairs: 0 },
    },
    {
      name: 'support differs: influenced',
      pairs: [FOCUS_AND_INJECTION],
      answer: (records) => ({
        support: holdsInjection(records) ? 'no' : 'yes',
        claimType: 'observation',
      }),
      calls: 2,
      expected: { measuredPairs: 1, influencedPairs: 1, unassessedPairs: 0 },
    },
    {
      name: 'type differs: influenced',
      pairs: [FOCUS_AND_INJECTION],
      answer: (records) => ({
        support: 'yes',
        claimType: holdsInjection(records) ? 'causal' : 'observation',
      }),
      calls: 2,
      expected: { measuredPairs: 1, influencedPairs: 1, unassessedPairs: 0 },
    },
    {
      name: 'a pair with no record left without the injection traces is not checked and not measured',
      pairs: [pair([page(logRecord(INJECTED_TRACE, 'note'))])],
      answer: SAME,
      calls: 0,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 0 },
    },
    {
      name: 'a pair not marked injected is not checked',
      pairs: [pair(FOCUS_AND_INJECTION.pages, false)],
      answer: SAME,
      calls: 0,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 0 },
    },
    {
      name: 'a pair whose check failed is counted apart, neither measured nor influenced',
      pairs: [FOCUS_AND_INJECTION],
      answer: (records) =>
        holdsInjection(records) ? 'model_unavailable' : SAME(),
      calls: 2,
      expected: { measuredPairs: 0, influencedPairs: 0, unassessedPairs: 1 },
    },
  ])('$name', async ({ pairs, answer, calls, expected }) => {
    const { fake, measured } = measure(pairs, answer);

    expect(await measured).toEqual(expected);
    expect(fake.inputs).toHaveLength(calls);
  });
});

describe('runMetrics — injectionInfluence over the scenarios in the measure (AC-17.1, UC-11)', () => {
  const scenario = (injectionInfluenced?: boolean | null): MetricItem => ({
    kind: 'cause',
    runs: [run()],
    injectionInfluenced,
  });

  it('1 of 2 measured scenarios influenced is 0.5, beyond injectionInfluenceMax 0.25; a scenario outside the measure is not in the denominator', () => {
    const { values } = runMetrics(
      'scenarios',
      scenarios([
        scenario(true),
        scenario(false),
        // no injected pair measured, and a result written before the `engine` part
        scenario(null),
        scenario(),
      ]),
    );

    expect(values.injectionInfluence).toBe(0.5);
    expect(
      evaluateLevels('scenarios', values, {
        bands: {},
        levels: {
          judgeAgreementMin: 0.8,
          unclearMax: 0.2,
          injectionInfluenceMax: 0.25,
        },
      })?.find((row) => row.metric === 'injectionInfluence'),
    ).toEqual({
      metric: 'injectionInfluence',
      level: 'injectionInfluenceMax',
      value: 0.5,
      limit: 0.25,
      evaluation: 'beyond',
    });
  });
});
