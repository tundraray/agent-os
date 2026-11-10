import { buildJudgeChecks, type JudgeCheck } from './judge-checks.js';
import { loadScenarioSet } from './scenario-sets.js';

const CAUSE_KINDS = [
  'change_and_link_established',
  'link_assumed',
  'link_absent',
  'change_assumed',
  'distractor_established',
  'honest_unknown',
];
const NO_CAUSE_KINDS = ['distractor_established', 'honest_unknown'];

// DC-8: check answers with a correct form known by construction. That every form names its claim ids in the section
// the form says is proven by the real checker in apps/api (form-check.spec, "accepts the correct form of every check
// answer of each scenario kind").
describe('buildJudgeChecks over the first set', () => {
  const loaded = loadScenarioSet('first');
  if (!loaded.ok) {
    throw new Error(loaded.detail);
  }
  const { set } = loaded;
  let checks: JudgeCheck[];

  beforeAll(() => {
    checks = buildJudgeChecks(set);
  }, 120_000);

  it('gives a cause scenario all six DC-8 kinds in order and a no-cause scenario the two that apply', () => {
    for (const scenario of set.scenarios) {
      const kinds = checks.filter((check) => check.scenarioId === scenario.scenarioId).map((check) => check.checkKind);
      expect(kinds, scenario.scenarioId).toEqual(scenario.params.mechanism === 'no_cause' ? NO_CAUSE_KINDS : CAUSE_KINDS);
    }
  });

  it.each([
    // [check kind, scenario kind, checks of that pair in the set, causeChange, causeLink, otherCauseEstablished]
    ['change_and_link_established', 'cause', 18, 'established', 'established', 'no'],
    ['link_assumed', 'cause', 18, 'established', 'assumed', 'no'],
    ['link_absent', 'cause', 18, 'established', 'absent', 'no'],
    ['change_assumed', 'cause', 18, 'assumed', 'absent', 'no'],
    ['distractor_established', 'cause', 18, 'absent', 'absent', 'yes'],
    ['honest_unknown', 'cause', 18, 'absent', 'absent', 'no'],
    ['distractor_established', 'no_cause', 6, 'not_applicable', 'not_applicable', 'yes'],
    ['honest_unknown', 'no_cause', 6, 'not_applicable', 'not_applicable', 'no'],
  ] as const)('fills the %s form of a %s scenario', (kind, scenarioKind, count, causeChange, causeLink, otherCause) => {
    const noCause = scenarioKind === 'no_cause';
    const ofKind = checks.filter(
      (check) => check.checkKind === kind && check.scenarioId.startsWith('no-cause-') === noCause,
    );
    expect(ofKind.length).toBe(count);
    for (const check of ofKind) {
      expect([check.form.causeChange, check.form.causeLink, check.form.otherCauseEstablished]).toEqual([
        causeChange,
        causeLink,
        otherCause,
      ]);
    }
  });
});
