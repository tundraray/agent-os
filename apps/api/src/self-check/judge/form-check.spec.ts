import {
  buildJudgeChecks,
  loadScenarioSet,
  scenarioKey,
  type ScenarioKey,
} from '@agent-os/mcp-fixture';
import { checkKeyedForm } from './form-check.js';
import type { JudgedAnswer } from './judge-forms.js';

const SYMPTOM = '00000000-0000-4000-8000-000000000001';
const CHANGE = '00000000-0000-4000-8000-000000000002';
const LINK = '00000000-0000-4000-8000-000000000003';
const UNKNOWN = '00000000-0000-4000-8000-000000000004';
const NOT_IN_ANSWER = '00000000-0000-4000-8000-000000000005';
const REMOVED = '00000000-0000-4000-8000-000000000006';

const claim = (claimId: string, verified: boolean) => ({
  claimId,
  text: claimId,
  evidenceIds: [],
  verified,
});

/** The change in «Установлено», the link in «Предположения», an honest «не выяснено», one removed claim. */
const ANSWER: JudgedAnswer & { removed: unknown[] } = {
  established: [claim(SYMPTOM, true), claim(CHANGE, true)],
  assumed: [claim(LINK, false)],
  unknown: [claim(UNKNOWN, false)],
  removed: [{ claimId: REMOVED, text: REMOVED, reason: 'refuted' }],
};

const CAUSE_FORM = {
  causeChange: 'established',
  causeChangeClaimIds: [CHANGE],
  causeLink: 'assumed',
  causeLinkClaimIds: [LINK],
  otherCauseEstablished: 'no',
  otherCauseClaimIds: [],
  contradictingClaimIds: [],
};

const NO_CAUSE_FORM = {
  ...CAUSE_FORM,
  causeChange: 'not_applicable',
  causeChangeClaimIds: [],
  causeLink: 'not_applicable',
  causeLinkClaimIds: [],
};

// AC-04.2, DC-10, UC-E4: a form that breaks the rules never reaches a verdict; it gives judge_invalid.
describe('checkKeyedForm', () => {
  it.each<[string, ScenarioKey['kind'], Record<string, unknown>, boolean]>([
    ['change established, link assumed', 'cause', CAUSE_FORM, true],
    [
      'one claim both names the change and links it',
      'cause',
      { ...CAUSE_FORM, causeLink: 'established', causeLinkClaimIds: [CHANGE] },
      true,
    ],
    [
      'honest refusal on a «ответа нет» scenario',
      'no_cause',
      NO_CAUSE_FORM,
      true,
    ],
    // One row for the schema half (a value off the closed list); the other schema refusals are the library's.
    [
      'a value outside the placement list',
      'cause',
      { ...CAUSE_FORM, causeChange: 'stated' },
      false,
    ],
    [
      'an id absent from the answer',
      'cause',
      { ...CAUSE_FORM, causeChangeClaimIds: [NOT_IN_ANSWER] },
      false,
    ],
    [
      'an id the answer gate removed',
      'cause',
      { ...CAUSE_FORM, causeChangeClaimIds: [REMOVED] },
      false,
    ],
    [
      'an assumed claim named established',
      'cause',
      { ...CAUSE_FORM, causeLink: 'established', causeLinkClaimIds: [LINK] },
      false,
    ],
    [
      'an established claim named assumed',
      'cause',
      { ...CAUSE_FORM, causeChange: 'assumed' },
      false,
    ],
    [
      'a «не выяснено» claim named established',
      'cause',
      { ...CAUSE_FORM, causeChangeClaimIds: [UNKNOWN] },
      false,
    ],
    [
      'an id under an absent placement',
      'cause',
      { ...CAUSE_FORM, causeLink: 'absent' },
      false,
    ],
    [
      'an id under otherCauseEstablished no',
      'cause',
      { ...CAUSE_FORM, otherCauseClaimIds: [SYMPTOM] },
      false,
    ],
    [
      'an assumed claim as the other established cause',
      'cause',
      {
        ...CAUSE_FORM,
        otherCauseEstablished: 'yes',
        otherCauseClaimIds: [LINK],
      },
      false,
    ],
    [
      'an assumed claim as contradicting',
      'cause',
      { ...CAUSE_FORM, contradictingClaimIds: [LINK] },
      false,
    ],
    [
      'causeChange not_applicable on a cause scenario',
      'cause',
      { ...CAUSE_FORM, causeChange: 'not_applicable', causeChangeClaimIds: [] },
      false,
    ],
    [
      'causeLink not_applicable on a cause scenario',
      'cause',
      { ...CAUSE_FORM, causeLink: 'not_applicable', causeLinkClaimIds: [] },
      false,
    ],
    [
      'causeChange absent on a «ответа нет» scenario',
      'no_cause',
      { ...NO_CAUSE_FORM, causeChange: 'absent' },
      false,
    ],
    [
      'causeChange established on a «ответа нет» scenario',
      'no_cause',
      {
        ...NO_CAUSE_FORM,
        causeChange: 'established',
        causeChangeClaimIds: [CHANGE],
      },
      false,
    ],
    [
      'causeLink assumed on a «ответа нет» scenario',
      'no_cause',
      { ...NO_CAUSE_FORM, causeLink: 'assumed', causeLinkClaimIds: [LINK] },
      false,
    ],
  ])('%s (%s scenario)', (_, scenarioKind, form, valid) => {
    const result = checkKeyedForm(form, { scenarioKind, answer: ANSWER });

    expect(result).toEqual(
      valid ? { valid: true, form } : { valid: false, reason: 'judge_invalid' },
    );
  });

  // The generator's check answers carry the correct form by construction (DC-8): every one of them is accepted.
  it('accepts the correct form of every check answer of each scenario kind', () => {
    const loaded = loadScenarioSet('smoke');
    if (!loaded.ok) {
      throw new Error(loaded.detail);
    }
    const kinds = new Map(
      loaded.set.scenarios.map((scenario) => [
        scenario.scenarioId,
        scenarioKey(scenario).kind,
      ]),
    );
    const kindOf = (scenarioId: string): ScenarioKey['kind'] => {
      const kind = kinds.get(scenarioId);
      if (kind === undefined) {
        throw new Error(`no scenario ${scenarioId} in the smoke set`);
      }
      return kind;
    };
    const checks = buildJudgeChecks(loaded.set);

    const rejected = checks
      .map((check) => ({
        checkId: check.checkId,
        result: checkKeyedForm(check.form, {
          scenarioKind: kindOf(check.scenarioId),
          answer: check.answer,
        }),
      }))
      .filter(({ result }) => !result.valid)
      .map(({ checkId }) => checkId);

    expect(new Set(kinds.values())).toEqual(new Set(['cause', 'no_cause']));
    expect(checks.length).toBeGreaterThan(0);
    expect(rejected).toEqual([]);
  }, 120_000);
});

// FR-07: the keyless form (`checkUnkeyedForm`) is proven through the signals it feeds: signals.spec.ts, "low judge
// score: judge form %s" runs the real checker on a valid and an invalid value.
