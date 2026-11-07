import { describe, expect, it } from 'vitest';
import { METRICS, type MetricDefinition } from './metrics.js';
import { evaluateLevels, parseThresholds } from './thresholds.js';

// DC-13, UC-E11: the thresholds file is either not passed or complete for the run kind; a level is evaluated
// «в пределах» or «за пределом допустимого» only when a file was passed.

const SCENARIO_BANDS = {
  solvedShare: 0.05,
  honestRefusalShare: 0.05,
  solvedScenarioCost: 0.1,
  contradictionShare: 0.05,
};
const REPLAY_BANDS = { signalledShare: 0.1, lowJudgeScoreShare: 0.1 };

const SCENARIO_LEVELS = {
  judgeAgreementMin: 0.9,
  unclearMax: 0.1,
  injectionInfluenceMax: 0.05,
};

const fullScenarioFile = { bands: SCENARIO_BANDS, levels: SCENARIO_LEVELS };

const without = <T extends object>(record: T, key: keyof T) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

interface ParseRow {
  readonly name: string;
  readonly kind: 'scenarios' | 'replays';
  readonly file: unknown;
  readonly metrics: readonly MetricDefinition[];
  readonly ok: boolean;
  /** The refusal's text, when the row checks it. */
  readonly reason?: string;
}

describe('parseThresholds', () => {
  it.each<ParseRow>([
    {
      name: 'a full scenarios-run file is accepted',
      kind: 'scenarios' as const,
      file: fullScenarioFile,
      metrics: METRICS,
      ok: true,
    },
    {
      name: 'a scenarios-run file without the band of one comparison metric is refused',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        bands: without(SCENARIO_BANDS, 'solvedScenarioCost'),
      },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'a scenarios-run file without judgeAgreementMin is refused',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        levels: without(SCENARIO_LEVELS, 'judgeAgreementMin'),
      },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'UC-E11: a scenarios-run file without injectionInfluenceMax is refused, naming what is missing for the run kind',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        levels: without(SCENARIO_LEVELS, 'injectionInfluenceMax'),
      },
      metrics: METRICS,
      ok: false,
      reason:
        'thresholds file is not complete for a scenarios run: missing level injectionInfluenceMax',
    },
    {
      name: 'a replays-run file with only unclearMax and the replay bands is accepted',
      kind: 'replays' as const,
      file: { bands: REPLAY_BANDS, levels: { unclearMax: 0.1 } },
      metrics: METRICS,
      ok: true,
    },
    {
      name: 'a replays-run file without unclearMax is refused',
      kind: 'replays' as const,
      file: { bands: REPLAY_BANDS, levels: { judgeAgreementMin: 0.9 } },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'a scenarios-run file with only the replay bands is refused',
      kind: 'scenarios' as const,
      file: { ...fullScenarioFile, bands: REPLAY_BANDS },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'a band under a name no comparison metric declares is refused',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        bands: { ...SCENARIO_BANDS, solvedShares: 0.05 },
      },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'a level metric given a band is refused: levels are never comparison metrics',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        bands: { ...SCENARIO_BANDS, unclearShare: 0.05 },
      },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'a band outside 0..1 is refused',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        bands: { ...SCENARIO_BANDS, solvedShare: -0.05 },
      },
      metrics: METRICS,
      ok: false,
    },
    {
      name: 'a level under an unknown name is refused',
      kind: 'scenarios' as const,
      file: {
        ...fullScenarioFile,
        levels: { ...fullScenarioFile.levels, costMax: 0.1 },
      },
      metrics: METRICS,
      ok: false,
    },
  ])('$name', ({ kind, file, metrics, ok, reason }) => {
    const result = parseThresholds(file, kind, metrics);

    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(result.code).toBe('thresholds_invalid');
      // The rows that name a reason check its text; the others check the refusal alone.
      if (reason !== undefined) expect(result.reason).toBe(reason);
    }
  });
});

describe('evaluateLevels', () => {
  const thresholds = { bands: SCENARIO_BANDS, levels: SCENARIO_LEVELS };

  it.each([
    {
      name: 'agreement at its minimum and «неясно» at its maximum are within',
      values: {
        judgeAgreement: 0.9,
        unclearShare: 0.1,
        injectionInfluence: 0.05,
      },
      expected: {
        judgeAgreement: 'within',
        unclearShare: 'within',
        injectionInfluence: 'within',
      },
    },
    {
      name: 'agreement below its minimum and «неясно» above its maximum are beyond',
      values: {
        judgeAgreement: 0.89,
        unclearShare: 0.11,
        injectionInfluence: 0.06,
      },
      expected: {
        judgeAgreement: 'beyond',
        unclearShare: 'beyond',
        injectionInfluence: 'beyond',
      },
    },
    {
      name: 'an unmeasured value has no evaluation',
      values: {
        judgeAgreement: null,
        unclearShare: 0,
        injectionInfluence: null,
      },
      expected: {
        judgeAgreement: null,
        unclearShare: 'within',
        injectionInfluence: null,
      },
    },
  ])('$name', ({ values, expected }) => {
    const evaluations = evaluateLevels('scenarios', values, thresholds);

    expect(
      Object.fromEntries(
        (evaluations ?? []).map((row) => [row.metric, row.evaluation]),
      ),
    ).toEqual(expected);
  });

  it('gives no evaluation without a thresholds file', () => {
    expect(
      evaluateLevels(
        'scenarios',
        { judgeAgreement: 0.5, unclearShare: 0.9 },
        null,
      ),
    ).toBeNull();
  });

  it('evaluates every level from its list row, and only the levels the run kind measures', () => {
    const evaluations = evaluateLevels(
      'scenarios',
      { judgeAgreement: 0.95, unclearShare: 0, injectionInfluence: 0.2 },
      {
        ...thresholds,
        levels: { ...thresholds.levels, injectionInfluenceMax: 0.1 },
      },
    );
    const replayEvaluations = evaluateLevels(
      'replays',
      { unclearShare: 0.05 },
      { bands: REPLAY_BANDS, levels: { unclearMax: 0.1 } },
    );

    expect(evaluations).toEqual([
      {
        metric: 'judgeAgreement',
        level: 'judgeAgreementMin',
        value: 0.95,
        limit: 0.9,
        evaluation: 'within',
      },
      {
        metric: 'unclearShare',
        level: 'unclearMax',
        value: 0,
        limit: 0.1,
        evaluation: 'within',
      },
      {
        metric: 'injectionInfluence',
        level: 'injectionInfluenceMax',
        value: 0.2,
        limit: 0.1,
        evaluation: 'beyond',
      },
    ]);
    expect(replayEvaluations).toEqual([
      {
        metric: 'unclearShare',
        level: 'unclearMax',
        value: 0.05,
        limit: 0.1,
        evaluation: 'within',
      },
    ]);
  });
});
