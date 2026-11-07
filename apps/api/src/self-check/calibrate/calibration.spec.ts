import {
  type AssessRequest,
  type AssessResult,
  type ClaimProfile,
  decideClaim,
  deepResearchProcessV2,
  loadProcessConfig,
  pointerOverAll,
  promptVersion,
} from '@agent-os/engine';
import {
  buildCalibrationPairs,
  type CalibrationPair,
  loadScenarioSet,
} from '@agent-os/mcp-fixture';
import { systemClock } from '@agent-os/runtime';
import { describe, expect, it } from 'vitest';
import {
  calibrate,
  type CalibrationReport,
  type GroupCount,
  renderCalibrationReport,
  splitIntoGroups,
} from './calibration.js';

// AC-06.1, AC-15.2, DC-1 (design-engine.md, «Как калибровка ставит таблицу групп»): calibration measures the rule the
// engine decides by — every pair goes through `buildClaimCheck`, `Engine.assess` with the `verifier` role and
// `decideClaim` — and builds the group table from the established pairs: profiles ranked by the lower bound of the
// 90 % Wilson interval of the share correct, cut into 3 or 4 consecutive groups of about equal established pairs,
// never splitting a profile (plan Notes 1, decision 1). Defects caught: a decision taken by another rule than
// `decideClaim`; ranking by the raw share (a profile of two pairs above one of ten); a profile split between groups;
// a failed or off-form pair counted as a right decision; a table bound to another model or prompt version.

const loaded = loadProcessConfig(deepResearchProcessV2);
if (!loaded.ok) throw new Error('the shipped configuration is refused');
const VERIFIER = loaded.config.roles.verifier;
const RUN_ID = 'self-check:run:2026-11-07T10-00-00-000Z-0a1b2c3d';

type Relation = 'supports' | 'contradicts' | 'unrelated';
type Support = 'yes' | 'no' | 'insufficient';
type Type = 'observation' | 'quantitative' | 'causal';

/** What the scripted verifier answers for a pair: its support, type and one relation per record. */
interface Answer {
  readonly support: Support;
  readonly claimType: Type;
  readonly relations: readonly Relation[];
}

/** A pair with its key and the answer the scripted verifier gives; `null` answers stand for a failed call. */
interface Scripted {
  readonly pair: CalibrationPair;
  readonly answer: Answer | 'model_unavailable' | 'off_form';
}

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

let pairCounter = 0;

/** One pair over one page whose records are one per relation, each with its own trace unless `traces` says. */
function scripted(
  key: Pick<
    CalibrationPair,
    'pairKind' | 'expectedSupport' | 'expectedType' | 'expectedValuesMatch'
  >,
  answer: Scripted['answer'],
  traces: readonly string[] = ['trace-a'],
): Scripted {
  pairCounter += 1;
  return {
    pair: {
      pairId: `scenario/pair-${pairCounter}`,
      scenarioId: 'scenario',
      injected: false,
      claimText: 'a claim the scripted verifier never reads',
      // Atoms the first record holds, as `buildCalibrationPairs` writes them: the value check runs on every pair.
      claimAtoms: [
        { kind: 'traceId', value: traces[0] ?? '' },
        { kind: 'service', value: 'payment-api' },
        { kind: 'event', value: 'payment.result' },
      ],
      pages: [
        {
          source: 'fixture',
          tool: 'get_trace',
          args: { traceId: traces[0] },
          snapshot: 'fx-v1-00000000',
          complete: true,
          records: traces.map((traceId, spanSeq) => ({
            ts: '2026-09-15T19:40:00.000Z',
            service: 'payment-api',
            level: 'error',
            event: 'payment.result',
            traceId,
            spanSeq,
            status: 'error',
            durationMs: 100,
            message: 'payment failed',
          })),
        },
      ],
      ...key,
    },
    answer,
  };
}

const SHOULD_BE_ESTABLISHED = {
  pairKind: 'supported',
  expectedSupport: 'yes',
  expectedType: 'observation',
  expectedValuesMatch: true,
} as const;
const SHOULD_NOT_BE_ESTABLISHED = {
  pairKind: 'values_match_meaning_wrong',
  expectedSupport: 'no',
  expectedType: 'observation',
  expectedValuesMatch: true,
} as const;

/** The four features the scripted answer gives a pair; `two` adds a second trace, `contradicting` a third record. */
interface ProfileShape {
  readonly claimType: 'observation' | 'quantitative';
  readonly two: boolean;
  readonly contradicting: boolean;
}

const profileOf = (shape: ProfileShape): ClaimProfile => ({
  claimType: shape.claimType,
  valueCheck: 'matched',
  independentRecords: shape.two ? 'two_or_more' : 'one',
  contradictions: shape.contradicting,
});

/** `total` pairs the verifier establishes with this profile, `correct` of them ones the key says to establish. */
function profilePairs(
  shape: ProfileShape,
  total: number,
  correct: number,
): Scripted[] {
  const traces = shape.two ? ['trace-a', 'trace-b'] : ['trace-a'];
  const relations: Relation[] = traces.map(() => 'supports');
  if (shape.contradicting) {
    traces.push('trace-c');
    relations.push('contradicts');
  }
  return Array.from({ length: total }, (_, index) =>
    scripted(
      index < correct ? SHOULD_BE_ESTABLISHED : SHOULD_NOT_BE_ESTABLISHED,
      { support: 'yes', claimType: shape.claimType, relations },
      traces,
    ),
  );
}

const OBSERVATION_ONE: ProfileShape = {
  claimType: 'observation',
  two: false,
  contradicting: false,
};
const OBSERVATION_TWO: ProfileShape = {
  claimType: 'observation',
  two: true,
  contradicting: false,
};
const QUANTITATIVE_ONE: ProfileShape = {
  claimType: 'quantitative',
  two: false,
  contradicting: false,
};
const QUANTITATIVE_TWO: ProfileShape = {
  claimType: 'quantitative',
  two: true,
  contradicting: false,
};

interface Run {
  readonly requests: AssessRequest<unknown>[];
  readonly outcome: Awaited<ReturnType<typeof calibrate>>;
}

async function run(
  pairs: readonly Scripted[],
  groupCount: GroupCount = 3,
): Promise<Run> {
  const byId = new Map(pairs.map((item) => [item.pair.pairId, item]));
  const order = pairs.map((item) => item.pair.pairId);
  const requests: AssessRequest<unknown>[] = [];
  const assess = <T>(request: AssessRequest<T>): Promise<AssessResult<T>> => {
    const item = byId.get(order[requests.length]!)!;
    requests.push(request as AssessRequest<unknown>);
    if (item.answer === 'model_unavailable') {
      return Promise.resolve({
        outcome: 'failed',
        code: 'model_unavailable',
        usage: USAGE,
      });
    }
    // In schema, but naming no record: the form rule of `decideClaim` refuses it.
    const output =
      item.answer === 'off_form'
        ? { support: 'yes', claimType: 'observation', records: [] }
        : {
            support: item.answer.support,
            claimType: item.answer.claimType,
            records: item.answer.relations.map((relation, record) => ({
              record,
              relation,
            })),
          };
    return Promise.resolve({
      outcome: 'answered',
      output: output as T,
      usage: USAGE,
    });
  };
  const outcome = await calibrate({
    pairSet: {
      pairs: pairs.map((item) => item.pair),
      fingerprint: 'abcdef012345',
    },
    scenarioSet: 'first',
    verifier: VERIFIER,
    groupCount,
    assess,
    selfCheckRunId: RUN_ID,
    clock: systemClock,
  });
  return { requests, outcome };
}

function reportOf({ outcome }: Run): CalibrationReport {
  if (!outcome.ok) throw new Error(`calibration refused: ${outcome.reason}`);
  return outcome.report;
}

// DC-1, DC-9: the pairs the fixture builds carry atoms in the engine's format, so a verifier that answers `yes` by the
// key gets the pair established exactly when its key says the values match. Caught: atoms the engine's value check
// never finds (a duration as a number, a count without the bucket key), which leave every supported pair
// `values_missing` and every calibration `calibration_empty`; a pair without atoms, whose value label the check would
// pass as «not applicable» whatever its key says (the fixture's own label test, folded here by the test audit).
describe('buildCalibrationPairs against the engine value check', () => {
  it.each(['smoke', 'first'])(
    'gives every pair of the %s set the value verdict its key states',
    (setName) => {
      const set = loadScenarioSet(setName);
      if (!set.ok) throw new Error(`set ${setName}: ${set.detail}`);
      const verdicts = buildCalibrationPairs(set.set).pairs.map((pair) => {
        const records = pair.pages.reduce(
          (sum, page) => sum + page.records.length,
          0,
        );
        const decision = decideClaim({
          assessment: {
            support: 'yes',
            claimType: 'observation',
            records: Array.from({ length: records }, (_, record) => ({
              record,
              relation: 'supports',
            })),
          },
          ...pointerOverAll(pair.pages),
          atoms: pair.claimAtoms,
          groupTable: undefined,
        });
        return [
          pair.pairId,
          pair.claimAtoms.length > 0,
          decision.status === 'supported',
        ];
      });
      expect(verdicts).toEqual(
        buildCalibrationPairs(set.set).pairs.map((pair) => [
          pair.pairId,
          true,
          pair.expectedValuesMatch,
        ]),
      );
    },
    120_000,
  );
});

describe('calibrate: the three shares per pair kind (AC-06.1, DC-1)', () => {
  it('compares support, type and the decideClaim outcome with the key of each pair', async () => {
    const calibration = await run([
      // All three match.
      scripted(SHOULD_BE_ESTABLISHED, {
        support: 'yes',
        claimType: 'observation',
        relations: ['supports'],
      }),
      // Wrong type, still established as the key wants.
      scripted(SHOULD_BE_ESTABLISHED, {
        support: 'yes',
        claimType: 'quantitative',
        relations: ['supports'],
      }),
      // Support wrong: established although the key says contradicted.
      scripted(
        {
          pairKind: 'contradicted',
          expectedSupport: 'no',
          expectedType: 'quantitative',
          expectedValuesMatch: false,
        },
        { support: 'yes', claimType: 'quantitative', relations: ['supports'] },
      ),
      // A causal claim is never established: the decision matches the key.
      scripted(
        {
          pairKind: 'causal',
          expectedSupport: 'yes',
          expectedType: 'causal',
          expectedValuesMatch: true,
        },
        { support: 'yes', claimType: 'causal', relations: ['supports'] },
      ),
    ]);

    expect(reportOf(calibration).table.pairKinds).toEqual([
      {
        pairKind: 'supported',
        supportMatch: 1,
        typeMatch: 0.5,
        decisionMatch: 1,
      },
      {
        pairKind: 'contradicted',
        supportMatch: 0,
        typeMatch: 1,
        decisionMatch: 0,
      },
      { pairKind: 'causal', supportMatch: 1, typeMatch: 1, decisionMatch: 1 },
    ]);
    // The same verifier call as in an investigation, bound to the calibration run.
    expect(calibration.requests[0]).toMatchObject({
      role: 'verifier',
      model: VERIFIER.model,
      effort: VERIFIER.effort,
      maxOutputTokens: VERIFIER.maxOutputTokens,
      instructions: VERIFIER.prompt,
      binding: { selfCheckRunId: RUN_ID },
    });
  });
});

describe('calibrate: ranking by the Wilson lower bound and the groups (AC-15.2, H-03)', () => {
  it.each<[string, Scripted[], unknown, unknown, boolean[]]>([
    [
      'puts a profile of two right pairs below one of nine right in ten, counts pairs and share per group and flags H-03',
      [
        ...profilePairs(OBSERVATION_ONE, 2, 2),
        ...profilePairs(OBSERVATION_TWO, 10, 9),
      ],
      [
        { profile: profileOf(OBSERVATION_TWO), group: 'high' },
        { profile: profileOf(OBSERVATION_ONE), group: 'medium' },
      ],
      [
        { group: 'high', establishedPairs: 10, correctShare: 0.9 },
        { group: 'medium', establishedPairs: 2, correctShare: 1 },
        { group: 'low', establishedPairs: 0, correctShare: 0 },
      ],
      // `high` is not more accurate than `medium` below it.
      [true, false, false],
    ],
    [
      'flags nothing when every group is more accurate than the one below',
      [
        ...profilePairs(OBSERVATION_ONE, 5, 5),
        ...profilePairs(OBSERVATION_TWO, 2, 1),
      ],
      [
        { profile: profileOf(OBSERVATION_ONE), group: 'high' },
        { profile: profileOf(OBSERVATION_TWO), group: 'medium' },
      ],
      [
        { group: 'high', establishedPairs: 5, correctShare: 1 },
        { group: 'medium', establishedPairs: 2, correctShare: 0.5 },
        { group: 'low', establishedPairs: 0, correctShare: 0 },
      ],
      [false, false, false],
    ],
  ])('%s', async (_, pairs, profiles, groups, flags) => {
    const report = reportOf(await run(pairs));

    expect(report.table.profiles).toEqual(profiles);
    expect(report.table.groups).toEqual(groups);
    expect(
      report.groups.map((group) => group.notMoreAccurateThanBelow),
    ).toEqual(flags);
  });

  it('builds four groups from very_high, profiles fewer than groups filling them from the top', async () => {
    const report = reportOf(
      await run(
        [
          ...profilePairs(QUANTITATIVE_TWO, 8, 8),
          ...profilePairs(QUANTITATIVE_ONE, 4, 4),
        ],
        4,
      ),
    );

    expect(report.table.groupCount).toBe(4);
    expect(report.table.profiles).toEqual([
      { profile: profileOf(QUANTITATIVE_TWO), group: 'very_high' },
      { profile: profileOf(QUANTITATIVE_ONE), group: 'high' },
    ]);
    expect(
      report.table.groups.map(({ group, establishedPairs }) => [
        group,
        establishedPairs,
      ]),
    ).toEqual([
      ['very_high', 8],
      ['high', 4],
      ['medium', 0],
      ['low', 0],
    ]);
    // Bound to the calibrated verifier: its model and the prompt version of its template.
    expect(report.table).toMatchObject({
      model: VERIFIER.model,
      promptVersion: promptVersion(VERIFIER.prompt),
      scenarioSet: 'first',
      pairsFingerprint: 'abcdef012345',
    });
  });
});

describe('splitIntoGroups: consecutive groups of about equal pairs, a profile never split (plan Notes 1, decision 1)', () => {
  it.each<[string, number[], GroupCount, number[]]>([
    ['equal profiles, one per group', [4, 4, 4], 3, [0, 1, 2]],
    [
      'small profiles gathered in the middle',
      [5, 1, 1, 1, 4],
      3,
      [0, 1, 1, 1, 2],
    ],
    ['a large profile kept whole', [10, 1, 1], 3, [0, 1, 2]],
    ['a tie broken by the smaller top group', [2, 2, 2, 2], 3, [0, 1, 2, 2]],
    [
      'four groups of two profiles',
      [3, 3, 3, 3, 3, 3, 3, 3],
      4,
      [0, 0, 1, 1, 2, 2, 3, 3],
    ],
    ['fewer profiles than groups, from the top', [5, 1], 4, [0, 1]],
  ])('%s', (_, sizes, groupCount, expected) => {
    expect(splitIntoGroups(sizes, groupCount)).toEqual(expected);
  });
});

describe('calibrate: refusals and failed pairs', () => {
  it('refuses with calibration_empty when no pair is established', async () => {
    const { outcome } = await run([
      scripted(SHOULD_BE_ESTABLISHED, {
        support: 'insufficient',
        claimType: 'observation',
        relations: ['unrelated'],
      }),
      scripted(SHOULD_NOT_BE_ESTABLISHED, 'model_unavailable'),
    ]);

    expect(outcome).toMatchObject({ ok: false, code: 'calibration_empty' });
  });

  it('counts an off-form pair and a pair with the provider unavailable as wrong decisions, listed apart', async () => {
    const unavailable = scripted(
      SHOULD_NOT_BE_ESTABLISHED,
      'model_unavailable',
    );
    const offForm = scripted(SHOULD_NOT_BE_ESTABLISHED, 'off_form');
    const report = reportOf(
      await run([unavailable, offForm, ...profilePairs(OBSERVATION_ONE, 1, 1)]),
    );

    expect(report.table.pairKinds).toContainEqual({
      pairKind: 'values_match_meaning_wrong',
      supportMatch: 0,
      typeMatch: 0,
      decisionMatch: 0,
    });
    expect(
      report.pairs
        .filter((pair) => pair.failure !== null)
        .map(({ pairId, failure }) => ({ pairId, failure })),
    ).toEqual([
      { pairId: unavailable.pair.pairId, failure: 'model_unavailable' },
      { pairId: offForm.pair.pairId, failure: 'invalid_assessment' },
    ]);
    const text = renderCalibrationReport(report, '/tables/group-table.json');
    expect(text).toContain(`${unavailable.pair.pairId} — model_unavailable`);
    expect(text).toContain(`${offForm.pair.pairId} — invalid_assessment`);
  });
});
