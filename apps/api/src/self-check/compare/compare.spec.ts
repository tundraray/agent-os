import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { METRICS, type MetricDefinition } from '../metrics.js';
import type { ItemResult, RunEntry, RunResult } from '../result/run-result.js';
import type { Thresholds } from '../thresholds.js';
import type { Verdict } from '../verdict/verdict.js';
import { type Comparison, compareRunFiles } from './compare.js';

// FR-05, AC-05.1, AC-05.2, DC-12, DC-13, DC-14, invariant 7, UC-14, UC-E6: the comparison of two result files is a
// deterministic calculation; its verdict comes only from the thresholds recorded in the candidate's file.

const RESAMPLING = { resamples: 400, seed: 20260914 };

const PASSED: Verdict = { verdict: 'passed', reason: 'passed' };
const FAILED: Verdict = { verdict: 'failed', reason: 'wrong_cause' };
const UNCLEAR: Verdict = { verdict: 'unclear', reason: 'judge_invalid' };

const entry = (verdict: Verdict, costUsd = 1): RunEntry => ({
  investigationId: 'inv',
  status: 'completed',
  answerOutcome: 'answered',
  stopReason: null,
  verdict,
  firstError: null,
  steps: 3,
  tokens: 100,
  costUsd,
  establishedClaims: 0,
  contradictingClaims: 0,
  signals: null,
});

/** A scenario with `passed` of `runs` runs passed, the others failed; every run costs `costUsd`. */
const scenario = (
  scenarioId: string,
  passed: number,
  { runs = 10, costUsd = 1, kind = 'cause' as ItemResult['kind'] } = {},
): ItemResult => ({
  item: { scenarioId },
  kind,
  ran: true,
  runs: Array.from({ length: runs }, (_, index) =>
    entry(index < passed ? PASSED : FAILED, costUsd),
  ),
});

const BANDS = {
  solvedShare: 0.05,
  honestRefusalShare: 0.05,
  solvedScenarioCost: 0.1,
  contradictionShare: 0.05,
};
const LEVELS = {
  judgeAgreementMin: 0.8,
  unclearMax: 0.2,
  injectionInfluenceMax: 0.25,
};
const THRESHOLDS: Thresholds = { bands: BANDS, levels: LEVELS };

/** Run ids in the form `run` writes them (`RUN_ID_PATTERN`), one per role of the comparison. */
const RUN_IDS = {
  base: '2026-11-07T00-00-00-000Z-0000ba5e',
  cand: '2026-11-07T01-00-00-000Z-0000ca4d',
} as const;

const runResult = (
  run: keyof typeof RUN_IDS,
  results: ItemResult[],
  overrides: Partial<RunResult> = {},
): RunResult => ({
  runId: RUN_IDS[run],
  kind: 'scenarios',
  createdAt: '2026-11-07T00:00:00.000Z',
  codeVersion: null,
  items: { kind: 'set', setName: 'smoke', setFingerprint: 'fp-1' },
  config: {
    fingerprint: `config-${run}`,
    roles: {
      plan: { model: 'm', promptVersion: 'p' },
      controller: { model: 'm', promptVersion: 'p' },
      worker: { model: 'm', promptVersion: 'p' },
      verifier: { model: 'm', promptVersion: 'p' },
      synthesis: { model: 'm', promptVersion: 'p' },
    },
    choice: null,
  },
  judge: { model: 'anthropic/claude-sonnet-5-5', promptVersion: 'j' },
  thresholds: null,
  complete: true,
  results,
  judgeAgreement: { correct: 9, total: 10 },
  // The comparison recomputes the metrics from `results`; the stored ones are not read.
  metrics: {
    values: {},
    firstErrorsByRole: { controller: 0, worker: 0, verifier: 0, synthesis: 0 },
  },
  ...overrides,
});

const compare = (
  baseline: RunResult | null,
  candidate: RunResult | null,
  metrics: readonly MetricDefinition[] = METRICS,
) => compareRunFiles({ baseline, candidate }, RESAMPLING, metrics);

function compared(
  baseline: RunResult,
  candidate: RunResult,
  metrics: readonly MetricDefinition[] = METRICS,
): Comparison {
  const outcome = compare(baseline, candidate, metrics);
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.comparison;
}

const metric = (comparison: Comparison, name: string) => {
  const row = comparison.metrics.find((candidate) => candidate.name === name);
  if (row === undefined) throw new Error(`no metric ${name}`);
  return row;
};

/** Every scenario solved 4 of 10 times by the baseline: per-scenario differences are equal, so the interval is a point. */
const baselineRun = (overrides: Partial<RunResult> = {}) =>
  runResult('base', [scenario('a', 4), scenario('b', 4)], overrides);

describe('compareRunFiles: the verdict of a comparison metric by its band (UC-14, DC-13)', () => {
  // The baseline solves each scenario 2 of 8 times (0.25); shares in eighths are exact, so the band can sit exactly
  // on the interval. Equal per-scenario differences make the interval a point.
  it.each([
    {
      name: 'an interval wholly above the band is «лучше»',
      candidatePassed: 4,
      band: 0.2,
      difference: 0.25,
      verdict: 'better',
    },
    {
      name: 'an interval at the band itself touches it and is «неясно»',
      candidatePassed: 4,
      band: 0.25,
      difference: 0.25,
      verdict: 'unclear',
    },
    {
      name: 'an interval inside the band is «неясно»',
      candidatePassed: 3,
      band: 0.25,
      difference: 0.125,
      verdict: 'unclear',
    },
    {
      name: 'an interval at minus the band touches it and is «неясно»',
      candidatePassed: 0,
      band: 0.25,
      difference: -0.25,
      verdict: 'unclear',
    },
    {
      name: 'an interval wholly below minus the band is «хуже»',
      candidatePassed: 0,
      band: 0.2,
      difference: -0.25,
      verdict: 'worse',
    },
  ])('$name', ({ candidatePassed, band, difference, verdict }) => {
    const comparison = compared(
      runResult('base', [
        scenario('a', 2, { runs: 8 }),
        scenario('b', 2, { runs: 8 }),
      ]),
      runResult(
        'cand',
        [
          scenario('a', candidatePassed, { runs: 8 }),
          scenario('b', candidatePassed, { runs: 8 }),
        ],
        {
          thresholds: { ...THRESHOLDS, bands: { ...BANDS, solvedShare: band } },
        },
      ),
    );

    expect(metric(comparison, 'solvedShare')).toMatchObject({
      baseline: 0.25,
      candidate: candidatePassed / 8,
      difference,
      interval: { lower: difference, upper: difference },
      band,
      verdict,
    });
  });

  /** A solved scenario whose every run has 10 established claims, `contradicting` of them named by the judge. */
  const withClaims = (contradicting: number): ItemResult => ({
    ...scenario('a', 10),
    runs: Array.from({ length: 10 }, () => ({
      ...entry(PASSED),
      establishedClaims: 10,
      contradictingClaims: contradicting,
    })),
  });

  // The inverted metrics: a fall is an improvement, so the difference is plus and the verdict «лучше».
  it.each([
    {
      name: 'the cost difference is plus when the candidate is cheaper, in shares of the baseline',
      // Baseline: cost 1 per run, 0.4 solved -> 2.5 per solved scenario; candidate: 0.5 solved -> 2.0, 20% cheaper.
      baseline: baselineRun(),
      candidate: runResult('cand', [scenario('a', 5), scenario('b', 5)], {
        thresholds: THRESHOLDS,
      }),
      metric: 'solvedScenarioCost',
      row: { baseline: 2.5, candidate: 2, relativeToBaseline: true },
      difference: 0.2,
    },
    {
      name: 'a share of contradicting claims that falls is plus',
      baseline: runResult('base', [withClaims(3)]),
      candidate: runResult('cand', [withClaims(1)], { thresholds: THRESHOLDS }),
      metric: 'contradictionShare',
      row: { baseline: 0.3, candidate: 0.1, relativeToBaseline: false },
      difference: 0.2,
    },
  ])('$name', ({ baseline, candidate, metric: name, row, difference }) => {
    const comparison = compared(baseline, candidate);

    const inverted = metric(comparison, name);
    expect(inverted).toMatchObject({ ...row, verdict: 'better' });
    expect(inverted.difference).toBeCloseTo(difference, 10);
  });
});

describe('compareRunFiles: the overall verdict (Design Doc rule)', () => {
  // The per-metric verdicts in the order of `METRICS` (solvedShare, honestRefusalShare, solvedScenarioCost,
  // contradictionShare), then the overall one. The runs have no no-cause scenario and no contradicting claim, so the
  // middle two metrics have no spread and are «неясно» in every row.
  it.each([
    {
      name: 'the design example: share of solved «лучше», cost «неясно» -> overall «лучше»',
      // Scenario a is never solved by the baseline: a resample that draws only a (about 1 in 4) has no baseline cost,
      // more than 5% of resamples, so the cost metric has no interval and is «неясно».
      baseline: runResult('base', [scenario('a', 0), scenario('b', 4)]),
      candidate: runResult('cand', [scenario('a', 2), scenario('b', 6)], {
        thresholds: THRESHOLDS,
      }),
      verdicts: ['better', 'unclear', 'unclear', 'unclear'],
      overall: 'better',
    },
    {
      name: 'one metric «хуже» makes the overall verdict «хуже» even with another «лучше»',
      // More solved (0.4 -> 0.5), but every run costs 2 instead of 1: 4.0 per solved scenario instead of 2.5.
      baseline: baselineRun(),
      candidate: runResult(
        'cand',
        [scenario('a', 5, { costUsd: 2 }), scenario('b', 5, { costUsd: 2 })],
        { thresholds: THRESHOLDS },
      ),
      verdicts: ['better', 'unclear', 'worse', 'unclear'],
      overall: 'worse',
    },
    {
      name: 'without «лучше» and «хуже» the overall verdict is «неясно»',
      baseline: baselineRun(),
      candidate: runResult('cand', [scenario('a', 4), scenario('b', 4)], {
        thresholds: THRESHOLDS,
      }),
      verdicts: ['unclear', 'unclear', 'unclear', 'unclear'],
      overall: 'unclear',
    },
  ])('$name', ({ baseline, candidate, verdicts, overall }) => {
    const comparison = compared(baseline, candidate);

    expect(comparison.metrics.map((row) => row.verdict)).toEqual(verdicts);
    expect(comparison.verdict).toBe(overall);
    expect(comparison.stoppedBy).toEqual([]);
  });

  it('without thresholds in the candidate: metrics and intervals, no verdict (DC-13, AC-05.2)', () => {
    const comparison = compared(
      baselineRun({ thresholds: THRESHOLDS }),
      runResult('cand', [scenario('a', 5), scenario('b', 5)]),
    );

    expect(comparison.thresholds).toBeNull();
    expect(comparison.verdict).toBeNull();
    const solved = metric(comparison, 'solvedShare');
    expect(solved.verdict).toBeNull();
    expect(solved.band).toBeNull();
    expect(solved.interval?.lower).toBeCloseTo(0.1, 10);
    expect(
      comparison.levels.every((row) => row.candidate.evaluation === null),
    ).toBe(true);
  });
});

describe('compareRunFiles: levels (DC-14, Contract «Файл порогов»)', () => {
  it.each([
    {
      name: 'candidate judge agreement below judgeAgreementMin',
      baseline: baselineRun(),
      candidateOverrides: { judgeAgreement: { correct: 7, total: 10 } },
      stop: {
        run: 'candidate',
        level: 'judgeAgreementMin',
        value: 0.7,
        limit: 0.8,
      },
    },
    {
      name: 'baseline share of «неясно» above unclearMax',
      baseline: runResult('base', [
        scenario('a', 4),
        {
          ...scenario('b', 4),
          runs: Array.from({ length: 10 }, (_, index) =>
            entry(index < 4 ? PASSED : UNCLEAR),
          ),
        },
      ]),
      candidateOverrides: {},
      stop: { run: 'baseline', level: 'unclearMax', value: 0.3, limit: 0.2 },
    },
  ])(
    '$name: overall «неясно» with the reason, before any metric verdict',
    ({ baseline, candidateOverrides, stop }) => {
      const comparison = compared(
        baseline,
        runResult('cand', [scenario('a', 10), scenario('b', 10)], {
          thresholds: THRESHOLDS,
          ...candidateOverrides,
        }),
      );

      expect(comparison.verdict).toBe('unclear');
      expect(comparison.stoppedBy).toHaveLength(1);
      expect(comparison.stoppedBy[0]).toMatchObject({
        run: stop.run,
        level: stop.level,
        limit: stop.limit,
      });
      expect(comparison.stoppedBy[0]?.value).toBeCloseTo(stop.value, 10);
      expect(comparison.metrics.every((row) => row.verdict === null)).toBe(
        true,
      );
      expect(metric(comparison, 'solvedShare').interval).not.toBeNull();
    },
  );

  it('Notes 1 decision 8: a baseline written before the engine part has no injection measure — its injectionInfluence is empty, the candidate beyond its level, and neither changes the overall verdict', () => {
    const measured = (
      item: ItemResult,
      influencedPairs: number,
    ): ItemResult => ({
      ...item,
      injection: { measuredPairs: 1, influencedPairs, unassessedPairs: 0 },
    });

    const comparison = compared(
      // The baseline's items carry no `injection` field, as a result file written before this part.
      baselineRun(),
      runResult(
        'cand',
        [measured(scenario('a', 5), 1), measured(scenario('b', 5), 0)],
        { thresholds: THRESHOLDS },
      ),
    );

    expect(comparison.verdict).toBe('better');
    expect(comparison.stoppedBy).toEqual([]);
    expect(comparison.metrics.map((row) => row.name)).not.toContain(
      'injectionInfluence',
    );
    expect(
      comparison.levels.find((level) => level.metric === 'injectionInfluence'),
    ).toEqual({
      metric: 'injectionInfluence',
      level: 'injectionInfluenceMax',
      limit: 0.25,
      baseline: { value: null, evaluation: null },
      candidate: { value: 0.5, evaluation: 'beyond' },
    });
  });
});

describe('compareRunFiles: refusals (DC-12, UC-E6, UC-E8, invariant 7)', () => {
  const candidate = runResult('cand', [scenario('a', 5), scenario('b', 5)], {
    thresholds: THRESHOLDS,
  });
  it.each([
    {
      name: 'different sets',
      baseline: baselineRun({
        items: { kind: 'set', setName: 'other', setFingerprint: 'fp-1' },
      }),
      candidate,
      code: 'runs_not_comparable',
    },
    {
      name: 'the same set name with another fingerprint',
      baseline: baselineRun({
        items: { kind: 'set', setName: 'smoke', setFingerprint: 'fp-2' },
      }),
      candidate,
      code: 'runs_not_comparable',
    },
    {
      name: 'different lists of investigations',
      baseline: runResult('base', [], {
        kind: 'replays',
        items: {
          kind: 'investigations',
          investigations: [{ base: 'main', investigationId: 'i-1' }],
        },
      }),
      candidate: runResult('cand', [], {
        kind: 'replays',
        items: {
          kind: 'investigations',
          investigations: [{ base: 'main', investigationId: 'i-2' }],
        },
      }),
      code: 'runs_not_comparable',
    },
    {
      name: 'different run kinds',
      baseline: baselineRun({ kind: 'replays' }),
      candidate,
      code: 'runs_not_comparable',
    },
    {
      name: 'different scenarios under the same set',
      baseline: runResult('base', [scenario('a', 4), scenario('c', 4)]),
      candidate,
      code: 'runs_not_comparable',
    },
    {
      name: 'an incomplete baseline (a scenario «не прогнан»)',
      baseline: baselineRun({ complete: false }),
      candidate,
      code: 'run_incomplete',
    },
    {
      name: 'an incomplete candidate',
      baseline: baselineRun(),
      candidate: { ...candidate, complete: false },
      code: 'run_incomplete',
    },
    {
      name: 'a baseline directory without a result file (a failed run)',
      baseline: null,
      candidate,
      code: 'run_incomplete',
    },
    {
      name: 'a candidate directory without a result file',
      baseline: baselineRun(),
      candidate: null,
      code: 'run_incomplete',
    },
  ])('$name -> $code', ({ baseline, candidate: candidateRun, code }) => {
    const outcome = compare(baseline, candidateRun);

    expect(outcome).toMatchObject({ ok: false, code });
  });

  it('a file that is not a result file throws instead of being compared', () => {
    expect(() =>
      compare({ runId: 'x' } as unknown as RunResult, baselineRun()),
    ).toThrow(/not a result file/);
  });

  // The run ids name the comparison directory: one not in the form `run` writes is refused before anything is compared.
  it.each([['../../outside'], ['base'], ['2026-11-07T00-00-00-000Z-XYZ']])(
    'a result file whose runId is %s -> invalid_arguments',
    (runId) => {
      const outcome = compare(baselineRun({ runId }), baselineRun());

      expect(outcome).toMatchObject({ ok: false, code: 'invalid_arguments' });
    },
  );
});

describe('compareRunFiles: determinism (property)', () => {
  const verdictArbitrary = fc.constantFrom(PASSED, FAILED, UNCLEAR);
  const runsArbitrary = fc.array(
    fc.record({
      verdict: verdictArbitrary,
      cost: fc.integer({ min: 0, max: 100 }),
    }),
    { minLength: 1, maxLength: 4 },
  );
  const itemsArbitrary = fc.array(
    fc.record({
      kind: fc.constantFrom<ItemResult['kind']>('cause', 'no_cause'),
      baseline: runsArbitrary,
      candidate: runsArbitrary,
    }),
    { minLength: 1, maxLength: 6 },
  );
  const toItem = (
    index: number,
    kind: ItemResult['kind'],
    runs: { verdict: Verdict; cost: number }[],
  ): ItemResult => ({
    item: { scenarioId: `s-${index}` },
    kind,
    ran: true,
    runs: runs.map(({ verdict, cost }) => entry(verdict, cost / 10)),
  });

  it('the same two files always give the same comparison, whatever the order of their scenarios', () => {
    fc.assert(
      fc.property(itemsArbitrary, fc.boolean(), (items, withThresholds) => {
        const baselineItems = items.map((item, index) =>
          toItem(index, item.kind, item.baseline),
        );
        const candidateItems = items.map((item, index) =>
          toItem(index, item.kind, item.candidate),
        );
        const thresholds = withThresholds ? THRESHOLDS : null;
        const baseline = runResult('base', baselineItems);
        const candidate = runResult('cand', candidateItems, { thresholds });

        const first = compared(baseline, candidate);
        const again = compared(
          structuredClone(baseline),
          structuredClone(candidate),
        );
        const reordered = compared(
          runResult('base', [...baselineItems].reverse()),
          runResult('cand', [...candidateItems].reverse(), { thresholds }),
        );

        expect(again).toEqual(first);
        expect(reordered).toEqual(first);
        expect(first.verdict === null).toBe(!withThresholds);
      }),
      { numRuns: 60 },
    );
  });
});
