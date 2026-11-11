import { sha256Hex } from '../canonical-json.js';
import type { Scenario } from './scenario-dataset.js';
import { scenarioKey, type ScenarioKey } from './scenario-key.js';
import type { MechanismName } from './scenario-params.js';
import type { ScenarioSet } from './scenario-sets.js';

/** The six check kinds of DC-8, in its order; a «ответа нет» scenario gets the last two. */
type JudgeCheckKind =
  | 'change_and_link_established'
  | 'link_assumed'
  | 'link_absent'
  | 'change_assumed'
  | 'distractor_established'
  | 'honest_unknown';

type Placement = 'established' | 'assumed' | 'absent' | 'not_applicable';

/** The keyed judge form with its seven fields (design-self-check.md, «Как выносится вердикт сценария»). */
interface JudgeForm {
  causeChange: Placement;
  causeChangeClaimIds: string[];
  causeLink: Placement;
  causeLinkClaimIds: string[];
  otherCauseEstablished: 'yes' | 'no';
  otherCauseClaimIds: string[];
  contradictingClaimIds: string[];
}

interface CheckClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  verified: boolean;
}

/** An answer with the sections and claim identifiers of an investigation answer (`RunRecord.answer`). */
interface CheckAnswer {
  answerId: string;
  outcome: 'answered' | 'inconclusive';
  stopReason: null;
  summary: null;
  established: CheckClaim[];
  assumed: CheckClaim[];
  unknown: CheckClaim[];
  removed: { claimId: string; text: string; reason: string }[];
}

/** A check answer and the form a judge must fill for it (DC-8). */
export interface JudgeCheck {
  checkId: string;
  scenarioId: string;
  checkKind: JudgeCheckKind;
  answer: CheckAnswer;
  form: JudgeForm;
}

/**
 * Check answers of every scenario of the set, in set order and DC-8 order. The answers quote the key's phrases, so the
 * correct form is known by construction: each named claim id stands in the section the form names. Nothing is stored.
 */
export function buildJudgeChecks(set: ScenarioSet): JudgeCheck[] {
  return set.scenarios.flatMap((scenario) => scenarioChecks(scenario, scenarioKey(scenario)));
}

/** Sections a check answer places its claims in; every claim is one of the key's statements. */
interface Layout {
  established: Statement[];
  assumed?: Statement[];
  unknown?: Statement[];
}
type Statement = 'symptom' | 'change' | 'link' | 'distractor' | 'unknown';

interface CheckTemplate {
  kind: JudgeCheckKind;
  layout: Layout;
  /** Form values; the claim ids follow from the layout. */
  causeChange: Placement;
  causeLink: Placement;
  otherCause: boolean;
}

const CAUSE_TEMPLATES: readonly CheckTemplate[] = [
  {
    kind: 'change_and_link_established',
    layout: { established: ['symptom', 'change', 'link'] },
    causeChange: 'established',
    causeLink: 'established',
    otherCause: false,
  },
  {
    kind: 'link_assumed',
    layout: { established: ['symptom', 'change'], assumed: ['link'] },
    causeChange: 'established',
    causeLink: 'assumed',
    otherCause: false,
  },
  {
    kind: 'link_absent',
    layout: { established: ['symptom', 'change'] },
    causeChange: 'established',
    causeLink: 'absent',
    otherCause: false,
  },
  {
    kind: 'change_assumed',
    layout: { established: ['symptom'], assumed: ['change'] },
    causeChange: 'assumed',
    causeLink: 'absent',
    otherCause: false,
  },
  {
    kind: 'distractor_established',
    layout: { established: ['symptom', 'distractor'] },
    causeChange: 'absent',
    causeLink: 'absent',
    otherCause: true,
  },
  {
    kind: 'honest_unknown',
    layout: { established: ['symptom'], unknown: ['unknown'] },
    causeChange: 'absent',
    causeLink: 'absent',
    otherCause: false,
  },
];

/** No planted change: only the false cause and the honest refusal apply, and both placements are `not_applicable`. */
const NO_CAUSE_TEMPLATES: readonly CheckTemplate[] = CAUSE_TEMPLATES.filter(
  (template) => template.kind === 'distractor_established' || template.kind === 'honest_unknown',
).map((template): CheckTemplate => ({ ...template, causeChange: 'not_applicable', causeLink: 'not_applicable' }));

/**
 * A false cause for a scenario the set gives no distractor record: the cause of another mechanism, which by
 * construction did not happen in this scenario.
 */
const STAND_IN_CAUSE: Readonly<Record<MechanismName, string>> = {
  timeout_lowered: 'ошибки записи в ledger вызвали рост ошибок оплаты',
  provider_slowed: 'ошибки записи в ledger вызвали рост ошибок оплаты',
  ledger_write_errors: 'провайдер стал отвечать медленнее, и это вызвало рост ошибок оплаты',
  payment_method_declined: 'ошибки записи в ledger вызвали рост ошибок оплаты',
  no_cause: 'понижение таймаута provider-adapter вызвало рост ошибок оплаты',
};

function scenarioChecks(scenario: Scenario, key: ScenarioKey): JudgeCheck[] {
  const texts = statementTexts(scenario, key);
  const templates = key.cause === null ? NO_CAUSE_TEMPLATES : CAUSE_TEMPLATES;
  return templates.map((template) => {
    const checkId = `${scenario.scenarioId}/${template.kind}`;
    const ids = new Map<Statement, string>();
    const claimsOf = (statements: Statement[] | undefined, verified: boolean): CheckClaim[] =>
      (statements ?? []).map((statement) => {
        const claimId = stableUuid(`${scenario.setName}/${checkId}/${statement}`);
        ids.set(statement, claimId);
        const text = texts[statement];
        if (text === undefined) {
          throw new Error(`judge check ${scenario.setName}/${checkId}: the key has no ${statement} statement`);
        }
        return { claimId, text, evidenceIds: [], verified };
      });
    const answer: CheckAnswer = {
      answerId: stableUuid(`${scenario.setName}/${checkId}`),
      outcome: template.kind === 'honest_unknown' ? 'inconclusive' : 'answered',
      stopReason: null,
      summary: null,
      established: claimsOf(template.layout.established, true),
      assumed: claimsOf(template.layout.assumed, false),
      unknown: claimsOf(template.layout.unknown, false),
      removed: [],
    };
    const idsOf = (statement: Statement): string[] => {
      const claimId = ids.get(statement);
      return claimId === undefined ? [] : [claimId];
    };
    return {
      checkId,
      scenarioId: scenario.scenarioId,
      checkKind: template.kind,
      answer,
      form: {
        causeChange: template.causeChange,
        causeChangeClaimIds: idsOf('change'),
        causeLink: template.causeLink,
        causeLinkClaimIds: idsOf('link'),
        otherCauseEstablished: template.otherCause ? 'yes' : 'no',
        otherCauseClaimIds: idsOf('distractor'),
        contradictingClaimIds: [],
      },
    };
  });
}

/** Texts of the key's statements; a no-cause key has no change and no link. */
function statementTexts(scenario: Scenario, key: ScenarioKey): Partial<Record<Statement, string>> {
  const { paymentFailures, changeAt } = key.facts;
  const since = `${changeAt.slice(0, 10)} ${changeAt.slice(11, 16)} UTC`;
  return {
    symptom: `после ${since} в логах ${paymentFailures.afterChange} ошибок оплаты, до ${since} — ${paymentFailures.beforeChange}`,
    change: key.cause?.changePhrase,
    link: key.cause?.linkPhrase,
    distractor: key.distractors[0]?.phrase ?? STAND_IN_CAUSE[scenario.params.mechanism],
    unknown: `по записям не удалось выяснить ответ на вопрос «${key.question}»: изменения, которое объясняло бы рост ошибок, в логах не найдено`,
  };
}

/** A UUID (version 5 layout) from SHA-256 of the name, so the same check always has the same ids. */
function stableUuid(name: string): string {
  const hex = sha256Hex(name);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
