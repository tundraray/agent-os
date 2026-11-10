import {
  type AssessAgentRequest,
  type AssessAgentResult,
  buildClaimCheck,
  claimAssessmentAgent,
  type ClaimProfile,
  deepResearchProcessV3,
  definitionMemoryFingerprint,
} from '@agent-os/engine';
import {
  buildCalibrationPairs,
  type CalibrationPair,
  loadScenarioSet,
} from '@agent-os/mcp-fixture';
import { systemClock } from '@agent-os/runtime';
import { describe, expect, it } from 'vitest';
import {
  atomCheckOf,
  calibrateAgent,
  type CalibrationReport,
  type GroupCount,
  renderCalibrationReport,
  splitIntoGroups,
} from './calibration.js';

// AC-06.1, AC-15.2, DC-1 (design-engine.md, «Как калибровка ставит таблицу групп»): calibration measures the rule the
// engine decides by — every pair goes through the checker agent by `Engine.assessAgent` and `decideClaim` — and builds
// the group table from the established pairs: profiles ranked by the lower bound of the 90 % Wilson interval of the
// share correct, cut into 3 or 4 consecutive groups of about equal established pairs, never splitting a profile (plan
// Notes 1, decision 1). Defects caught: a decision taken by another rule than `decideClaim`; ranking by the raw share (a
// profile of two pairs above one of ten); a profile split between groups; a failed or off-form pair counted as a right
// decision; a table bound to another model or checker.

const CHECKER = claimAssessmentAgent(deepResearchProcessV3);
if (CHECKER === null) throw new Error('v3 has no claim_assessment definition');
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
        { kind: 'text', value: traces[0] ?? '' },
        { kind: 'text', value: 'payment-api' },
        { kind: 'text', value: 'payment.result' },
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
  readonly requests: AssessAgentRequest[];
  readonly outcome: Awaited<ReturnType<typeof calibrateAgent>>;
}

/** The checker agent answers each pair in order: an accepted `finish` with the scripted assessment, or a failed call. */
async function run(
  pairs: readonly Scripted[],
  groupCount: GroupCount = 3,
): Promise<Run> {
  const byId = new Map(pairs.map((item) => [item.pair.pairId, item]));
  const order = pairs.map((item) => item.pair.pairId);
  const requests: AssessAgentRequest[] = [];
  const assessAgent = (
    request: AssessAgentRequest,
  ): Promise<AssessAgentResult> => {
    const item = byId.get(order[requests.length]!)!;
    requests.push(request);
    if (item.answer === 'model_unavailable') {
      return Promise.resolve({
        outcome: 'failed',
        code: 'model_unavailable',
        usage: USAGE,
      });
    }
    // In schema, but naming no record: the form rule of `decideClaim` refuses it.
    const assessment =
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
      outcome: 'finished',
      result: { assessment },
      usage: USAGE,
    });
  };
  const outcome = await calibrateAgent({
    pairSet: {
      pairs: pairs.map((item) => item.pair),
      fingerprint: 'abcdef012345',
    },
    scenarioSet: 'first',
    config: deepResearchProcessV3,
    agent: CHECKER!,
    deploymentEntries: [],
    groupCount,
    assessAgent,
    selfCheckRunId: RUN_ID,
    clock: systemClock,
  });
  return { requests, outcome };
}

function reportOf({ outcome }: Run): CalibrationReport {
  if (!outcome.ok) throw new Error(`calibration refused: ${outcome.reason}`);
  return outcome.report;
}

describe('calibrateAgent: the three shares per pair kind (AC-06.1, DC-1)', () => {
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
    expect(calibration.requests).toHaveLength(4);
  });
});

// AC-13.1, UC-10 (design-engine.md, «Как калибровка ставит таблицу групп», step 2): a pair should be established when
// its records support it and it is not causal, the engine's own rule, where the atom check only enters the profile.
// Defect caught: calibration keying «should be established» on the values matching, so a confirmed pair whose atoms
// are missing counts as a wrong decision and a pair whose values match but meaning is wrong as a right one.
describe('calibrateAgent: «should be established» by the engine rule, without the values', () => {
  it('counts a confirmed pair right whatever its values, and a confirmed pair of wrong meaning wrong', async () => {
    const valuesFound = scripted(
      {
        pairKind: 'supported',
        expectedSupport: 'yes',
        expectedType: 'observation',
        expectedValuesMatch: true,
      },
      { support: 'yes', claimType: 'observation', relations: ['supports'] },
    );
    const valuesMissing = scripted(
      {
        pairKind: 'supported',
        expectedSupport: 'yes',
        expectedType: 'observation',
        expectedValuesMatch: false,
      },
      { support: 'yes', claimType: 'observation', relations: ['supports'] },
    );
    const missingPair: Scripted = {
      ...valuesMissing,
      pair: {
        ...valuesMissing.pair,
        claimAtoms: [{ kind: 'text', value: 'checkout-api' }],
      },
    };
    const meaningWrong = scripted(SHOULD_NOT_BE_ESTABLISHED, {
      support: 'yes',
      claimType: 'observation',
      relations: ['supports'],
    });

    const report = reportOf(
      await run([valuesFound, missingPair, meaningWrong]),
    );

    expect(
      report.pairs.map(({ pairKind, shouldBeEstablished, established }) => [
        pairKind,
        shouldBeEstablished,
        established,
      ]),
    ).toEqual([
      ['supported', true, true],
      ['supported', true, true],
      ['values_match_meaning_wrong', false, true],
    ]);
    expect(report.table.pairKinds).toEqual([
      {
        pairKind: 'supported',
        supportMatch: 1,
        typeMatch: 1,
        decisionMatch: 1,
      },
      {
        pairKind: 'values_match_meaning_wrong',
        supportMatch: 0,
        typeMatch: 1,
        decisionMatch: 0,
      },
    ]);
    // The atom check enters the profile only: the missing atom gives `unmatched`.
    expect(
      report.pairs.map((outcome) => outcome.profile?.valueCheck ?? null),
    ).toEqual(['matched', 'unmatched', 'matched']);
  });
});

// AC-13.2 (design-engine.md, «Как калибровка ставит таблицу групп», step 3; Contract, command `calibrate`): beside the
// algorithm's share per pair kind the report shows the share the old veto «value check `unmatched` — not established»
// would give on the same pairs, and each of the three value check results under its own label. Defects caught: an
// `unmatched` profile printed as «без атомов»; a veto share counted over other pairs than the kind's own.
describe('renderCalibrationReport: the old veto share and the value check labels (AC-13.2)', () => {
  const withAtoms = (item: Scripted, atoms: CalibrationPair['claimAtoms']) => ({
    ...item,
    pair: { ...item.pair, claimAtoms: atoms },
  });
  const CONFIRMED: Answer = {
    support: 'yes',
    claimType: 'observation',
    relations: ['supports'],
  };
  const MISSING_ATOM: CalibrationPair['claimAtoms'] = [
    { kind: 'text', value: 'checkout-api' },
  ];

  it('puts the veto share next to the algorithm share per pair kind and labels matched, unmatched and no atoms apart', async () => {
    const report = reportOf(
      await run([
        // Values match, meaning wrong, confirmed: the algorithm and the veto both establish it — both wrong.
        scripted(SHOULD_NOT_BE_ESTABLISHED, CONFIRMED),
        // Contradicted, a value missing, confirmed: the algorithm establishes it (wrong), the veto does not (right).
        withAtoms(
          scripted(
            {
              pairKind: 'contradicted',
              expectedSupport: 'no',
              expectedType: 'observation',
              expectedValuesMatch: false,
            },
            CONFIRMED,
          ),
          MISSING_ATOM,
        ),
        // Supported and confirmed: values match — both right; a value missing — only the algorithm right; no atoms —
        // both right, `not_applicable` is not vetoed.
        scripted(SHOULD_BE_ESTABLISHED, CONFIRMED),
        withAtoms(scripted(SHOULD_BE_ESTABLISHED, CONFIRMED), MISSING_ATOM),
        withAtoms(scripted(SHOULD_BE_ESTABLISHED, CONFIRMED), []),
      ]),
    );

    const lines = renderCalibrationReport(
      report,
      '/tables/group-table.json',
    ).split('\n');

    expect(lines).toContain(
      '| Вид пары | «Подтверждают ли» | Тип | Решение алгоритма | Прежнее вето «значения не совпали — не установлено» |',
    );
    expect(lines).toContain(
      '| values_match_meaning_wrong | 0.0 % | 100.0 % | 0.0 % | 0.0 % |',
    );
    expect(lines).toContain(
      '| contradicted | 0.0 % | 100.0 % | 0.0 % | 100.0 % |',
    );
    expect(lines).toContain(
      '| supported | 100.0 % | 100.0 % | 100.0 % | 66.7 % |',
    );
    const profileRows = lines.filter((line) =>
      line.startsWith('| observation, '),
    );
    expect(
      ['значения совпали', 'значения не совпали', 'без атомов'].map(
        (label) =>
          profileRows.filter((row) =>
            row.startsWith(`| observation, ${label}, `),
          ).length,
      ),
    ).toEqual([1, 1, 1]);
  });
});

describe('calibrateAgent: ranking by the Wilson lower bound and the groups (AC-15.2, H-03)', () => {
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
    // Bound to the calibrated checker: its model and the pair of fingerprints.
    expect(report.table).toMatchObject({
      model: CHECKER!.model,
      agentFingerprint: CHECKER!.agentFingerprint,
      definitionMemoryFingerprint: definitionMemoryFingerprint([]),
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

describe('calibrateAgent: refusals and failed pairs', () => {
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

// AC-16.2, AC-16.3, Flow 4 (design-research-flow.md, «Калибровка проверяющего агента»): the agents form judges each pair
// with `Engine.assessAgent` on the prologue input built from the pair's records. Defects caught: a packet other than the
// prologue's, so the table does not fit the real checker; a table without the two fingerprints; a failed pair that stops
// the calibration or earns a profile; a build defect (`rejected`) reported as an ordinary wrong pair.
describe('calibrateAgent: the agents form (AC-16.2, AC-16.3, Flow 4)', () => {
  const AGENT = claimAssessmentAgent(deepResearchProcessV3);
  if (AGENT === null) throw new Error('v3 has no claim_assessment definition');
  const MEMORY = [{ id: 'entry-1', text: 'a rule of the deployment' }];
  const CONFIRMED: Answer = {
    support: 'yes',
    claimType: 'observation',
    relations: ['supports'],
  };

  const finished = (answer: Answer): AssessAgentResult => ({
    outcome: 'finished',
    result: {
      claimId: 'scenario/pair',
      status: 'supported',
      group: null,
      profile: profileOf(OBSERVATION_ONE),
      assessment: {
        support: answer.support,
        claimType: answer.claimType,
        records: answer.relations.map((relation, record) => ({
          record,
          relation,
        })),
      },
    },
    usage: USAGE,
  });
  const CONFIRMED_RESULT = finished(CONFIRMED);
  const pairOf = (
    key: Parameters<typeof scripted>[0] = SHOULD_BE_ESTABLISHED,
  ) => scripted(key, CONFIRMED).pair;

  async function runAgent(
    script: readonly {
      readonly pair: CalibrationPair;
      readonly result: AssessAgentResult;
    }[],
  ) {
    const requests: AssessAgentRequest[] = [];
    const outcome = await calibrateAgent({
      pairSet: {
        pairs: script.map((item) => item.pair),
        fingerprint: 'abcdef012345',
      },
      scenarioSet: 'first',
      config: deepResearchProcessV3,
      agent: AGENT!,
      deploymentEntries: MEMORY,
      groupCount: 3,
      assessAgent: (request) => {
        const item = script[requests.length]!;
        requests.push(request);
        return Promise.resolve(item.result);
      },
      selfCheckRunId: RUN_ID,
      clock: systemClock,
    });
    return { requests, outcome };
  }

  it('gives assessAgent the prologue input whose packet equals the check of the same records (AC-16.3)', async () => {
    const pair = pairOf();

    const { requests } = await runAgent([{ pair, result: CONFIRMED_RESULT }]);

    const [request] = requests;
    expect(request).toMatchObject({
      agentName: 'verifier',
      config: deepResearchProcessV3,
      deploymentEntries: MEMORY,
      binding: { selfCheckRunId: RUN_ID },
    });
    const input = request!.prologueInput as {
      kind: string;
      claimId: string;
      text: string;
      atoms: CalibrationPair['claimAtoms'];
      pages: (CalibrationPair['pages'][number] & { pageId: string })[];
      agentFingerprint: string;
      definitionMemoryFingerprint: string;
    };
    expect(input).toMatchObject({
      kind: 'claim',
      claimId: pair.pairId,
      text: pair.claimText,
      atoms: pair.claimAtoms,
      agentFingerprint: AGENT.agentFingerprint,
    });
    const packet = (
      claimText: string,
      atoms: CalibrationPair['claimAtoms'],
      pages: CalibrationPair['pages'],
    ): string =>
      buildClaimCheck({
        claimText,
        atomCheck: atomCheckOf(atoms, pages),
        pages,
      });
    expect(packet(input.text, input.atoms, input.pages)).toBe(
      packet(pair.claimText, pair.claimAtoms, pair.pages),
    );
  });

  it('writes a table keyed by the two fingerprints, with the model and the set (AC-16.2)', async () => {
    const { outcome } = await runAgent([
      { pair: pairOf(), result: CONFIRMED_RESULT },
    ]);

    if (!outcome.ok) throw new Error(outcome.reason);
    const { table } = outcome.report;
    expect(table).toMatchObject({
      model: 'anthropic/claude-haiku-5-5',
      agentFingerprint: AGENT.agentFingerprint,
      definitionMemoryFingerprint: definitionMemoryFingerprint([
        {
          id: 'entry-1',
          scope: 'deployment',
          text: 'a rule of the deployment',
        },
      ]),
      scenarioSet: 'first',
      pairsFingerprint: 'abcdef012345',
      profiles: [{ profile: profileOf(OBSERVATION_ONE), group: 'high' }],
    });
    const text = renderCalibrationReport(outcome.report, '/tables/v3.json');
    expect(text).toContain(`отпечаток агента: ${AGENT.agentFingerprint}`);
    expect(text).not.toContain('undefined');
  });

  it.each<[string, AssessAgentResult, string]>([
    [
      'a packet over the limit',
      {
        outcome: 'ended',
        result: {
          claimId: 'scenario/pair',
          status: 'insufficient',
          group: null,
        },
        usage: USAGE,
      },
      'needs_narrowing',
    ],
    [
      'a second answer off the form',
      { outcome: 'invalid_result', usage: USAGE },
      'invalid_assessment',
    ],
    ...(
      [
        'model_unavailable',
        'not_after',
        'context_overflow',
        'prologue_oversize',
        'prologue_refused',
      ] as const
    ).map((code): [string, AssessAgentResult, string] => [
      `the failed outcome ${code}`,
      { outcome: 'failed', code, usage: USAGE },
      code,
    ]),
  ])(
    'lists %s as a wrong pair without a profile and judges the next pair',
    async (_, result, failure) => {
      const wrong = pairOf();
      const next = pairOf();

      const { requests, outcome } = await runAgent([
        { pair: wrong, result },
        { pair: next, result: CONFIRMED_RESULT },
      ]);

      if (!outcome.ok) throw new Error(outcome.reason);
      expect(requests).toHaveLength(2);
      expect(outcome.report.pairs[0]).toMatchObject({
        pairId: wrong.pairId,
        failure,
        decisionCorrect: false,
        profile: null,
      });
      expect(outcome.report.pairs[1]).toMatchObject({
        pairId: next.pairId,
        failure: null,
        decisionCorrect: true,
      });
      expect(outcome.report.usage.inputTokens).toBe(20);
      expect(
        renderCalibrationReport(outcome.report, '/tables/v3.json'),
      ).toContain(`${wrong.pairId} — ${failure}`);
    },
  );

  it.each(['agent_not_detachable', 'model_unavailable'] as const)(
    'ends the calibration with %s when the call is rejected, a defect of the build',
    async (code) => {
      const { requests, outcome } = await runAgent([
        { pair: pairOf(), result: { outcome: 'rejected', code } },
        { pair: pairOf(), result: CONFIRMED_RESULT },
      ]);

      expect(outcome).toMatchObject({ ok: false, code });
      expect(requests).toHaveLength(1);
    },
  );
});

// design-self-check.md 1.7.2, `CalibrationPair.expectedValuesMatch`: the key says what the engine's atom check gives
// on the pair's records. Defect caught: a generator whose atoms the engine's check does not find (or finds where the
// key says it must not), so calibration ranks profiles the engine never gives — the generator's own spec cannot see it.
describe('calibration pairs against the engine atom check', () => {
  it.each(['smoke', 'first'])(
    'gives matched exactly on the pairs of the %s set whose key expects the values to match',
    (setName) => {
      const loadedSet = loadScenarioSet(setName);
      if (!loadedSet.ok) throw new Error(`set ${setName}: ${loadedSet.detail}`);
      const mismatched = buildCalibrationPairs(loadedSet.set)
        .pairs.map((pair) => ({
          pairId: pair.pairId,
          expected: pair.expectedValuesMatch ? 'matched' : 'unmatched',
          actual: atomCheckOf(pair.claimAtoms, pair.pages).valueCheck,
        }))
        .filter(({ expected, actual }) => expected !== actual);

      expect(mismatched).toEqual([]);
    },
    120_000,
  );
});
