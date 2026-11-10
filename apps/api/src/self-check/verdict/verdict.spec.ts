import type { ScenarioKey } from '@agent-os/mcp-fixture';
import { checkKeyedForm } from '../judge/form-check.js';
import type { JudgedAnswer } from '../judge/judge-forms.js';
import { scenarioVerdict, type Verdict } from './verdict.js';

const SYMPTOM = '00000000-0000-4000-8000-000000000001';
const CHANGE = '00000000-0000-4000-8000-000000000002';
const UNGROUNDED_CHANGE = '00000000-0000-4000-8000-000000000003';
const LINK = '00000000-0000-4000-8000-000000000004';
const OTHER_CAUSE = '00000000-0000-4000-8000-000000000005';
const GUESS = '00000000-0000-4000-8000-000000000006';

const KEY_TRACE = 'trace-key-1';
const PAGE_WITH_KEY_TRACE = 'evidence-with-key-trace';
const PAGE_WITHOUT_KEY_TRACE = 'evidence-without-key-trace';

/** The trace ids of each page's records, as the run command reads them from the pages. */
const PAGE_TRACE_IDS = new Map<string, readonly string[]>([
  [PAGE_WITH_KEY_TRACE, ['trace-other-1', KEY_TRACE]],
  [PAGE_WITHOUT_KEY_TRACE, ['trace-other-1', 'trace-other-2']],
]);

const claim = (claimId: string, evidenceIds: string[], verified: boolean) => ({
  claimId,
  text: claimId,
  evidenceIds,
  verified,
});

/**
 * «Установлено»: the symptom, the change on a page with a key trace, the change on a page without one, another
 * cause. «Предположения»: the link, a guess about the cause.
 */
const ANSWER: JudgedAnswer = {
  established: [
    claim(SYMPTOM, [PAGE_WITH_KEY_TRACE], true),
    claim(CHANGE, [PAGE_WITHOUT_KEY_TRACE, PAGE_WITH_KEY_TRACE], true),
    claim(UNGROUNDED_CHANGE, [PAGE_WITHOUT_KEY_TRACE], true),
    claim(OTHER_CAUSE, [PAGE_WITHOUT_KEY_TRACE], true),
  ],
  assumed: [
    claim(LINK, [PAGE_WITH_KEY_TRACE], false),
    claim(GUESS, [PAGE_WITHOUT_KEY_TRACE], false),
  ],
  unknown: [],
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

const passed: Verdict = { verdict: 'passed', reason: 'passed' };
const failed = (
  reason: Extract<Verdict, { verdict: 'failed' }>['reason'],
): Verdict => ({
  verdict: 'failed',
  reason,
});

// AC-04.1, DC-11, UC-10, UC-11, invariant 4: one row per branch of the ladder; passed needs a checked form, the change
// in «Установлено» on a page with a key trace and the link established or assumed.
describe('scenarioVerdict', () => {
  it.each<[string, ScenarioKey['kind'], Record<string, unknown>, Verdict]>([
    [
      'a form that breaks the rules gives judge_invalid',
      'cause',
      { ...CAUSE_FORM, causeChange: 'stated' },
      { verdict: 'unclear', reason: 'judge_invalid' },
    ],
    [
      'another cause in «Установлено» gives wrong_cause',
      'cause',
      {
        ...CAUSE_FORM,
        otherCauseEstablished: 'yes',
        otherCauseClaimIds: [OTHER_CAUSE],
      },
      failed('wrong_cause'),
    ],
    [
      'another cause in «Установлено» on «ответа нет» gives cause_invented',
      'no_cause',
      {
        ...NO_CAUSE_FORM,
        otherCauseEstablished: 'yes',
        otherCauseClaimIds: [OTHER_CAUSE],
      },
      failed('cause_invented'),
    ],
    [
      'a guess in «Предположения» on «ответа нет» passes',
      'no_cause',
      NO_CAUSE_FORM,
      passed,
    ],
    [
      'the change only in «Предположения» gives cause_not_established',
      'cause',
      { ...CAUSE_FORM, causeChange: 'assumed', causeChangeClaimIds: [GUESS] },
      failed('cause_not_established'),
    ],
    [
      'the change absent gives cause_not_established',
      'cause',
      { ...CAUSE_FORM, causeChange: 'absent', causeChangeClaimIds: [] },
      failed('cause_not_established'),
    ],
    [
      'the change on a page without a key trace gives cause_not_grounded',
      'cause',
      { ...CAUSE_FORM, causeChangeClaimIds: [UNGROUNDED_CHANGE] },
      failed('cause_not_grounded'),
    ],
    [
      'the change established with no claim named gives cause_not_grounded',
      'cause',
      { ...CAUSE_FORM, causeChangeClaimIds: [] },
      failed('cause_not_grounded'),
    ],
    [
      'established and grounded, causeLink absent gives cause_not_linked',
      'cause',
      { ...CAUSE_FORM, causeLink: 'absent', causeLinkClaimIds: [] },
      failed('cause_not_linked'),
    ],
    [
      'established and grounded, causeLink assumed passes',
      'cause',
      CAUSE_FORM,
      passed,
    ],
    [
      'established and grounded, causeLink established passes',
      'cause',
      {
        ...CAUSE_FORM,
        causeChangeClaimIds: [UNGROUNDED_CHANGE, CHANGE],
        causeLink: 'established',
        causeLinkClaimIds: [CHANGE],
      },
      passed,
    ],
  ])('%s', (_, kind, judgeOutput, expected) => {
    const form = checkKeyedForm(judgeOutput, {
      scenarioKind: kind,
      answer: ANSWER,
    });

    const verdict = scenarioVerdict({
      answer: ANSWER,
      form,
      key: { kind, causeTraceIds: kind === 'cause' ? [KEY_TRACE] : [] },
      pageTraceIds: PAGE_TRACE_IDS,
    });

    expect(verdict).toEqual(expected);
  });

  it('refuses to judge grounding when a cited page has no trace ids read', () => {
    const form = checkKeyedForm(CAUSE_FORM, {
      scenarioKind: 'cause',
      answer: ANSWER,
    });

    expect(() =>
      scenarioVerdict({
        answer: ANSWER,
        form,
        key: { kind: 'cause', causeTraceIds: [KEY_TRACE] },
        pageTraceIds: new Map([[PAGE_WITHOUT_KEY_TRACE, []]]),
      }),
    ).toThrow(PAGE_WITH_KEY_TRACE);
  });

  it('gives no_answer to a run that ended without an answer, before any judge form', () => {
    expect(scenarioVerdict({ answer: null })).toEqual({
      verdict: 'unclear',
      reason: 'no_answer',
    });
  });
});
