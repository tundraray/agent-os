import type { ScenarioKey } from '@agent-os/mcp-fixture';
import {
  JUDGED_SECTIONS,
  type JudgedAnswer,
  type JudgedSection,
  type KeyedJudgeForm,
  KeyedJudgeFormSchema,
  type Placement,
  type UnkeyedJudgeForm,
  UnkeyedJudgeFormSchema,
} from './judge-forms.js';

/** A form that passed the check, or the verdict reason of one that did not (AC-04.2, DC-10). */
export type FormCheckResult<Form> =
  { valid: true; form: Form } | { valid: false; reason: 'judge_invalid' };

export interface KeyedFormContext {
  readonly scenarioKind: ScenarioKey['kind'];
  readonly answer: JudgedAnswer;
}

const INVALID = { valid: false, reason: 'judge_invalid' } as const;

/** The section a placement names; `absent` and `not_applicable` name none, so they take no claim ids. */
const SECTION_OF_PLACEMENT: Readonly<Record<Placement, JudgedSection | null>> =
  {
    established: 'established',
    assumed: 'assumed',
    absent: null,
    not_applicable: null,
  };

/**
 * Checks the keyed judge form by its fields and the answer's claim identifiers only (design-self-check.md, «Что
 * проверяет алгоритм в форме»): values from the closed lists; every named id stands in the answer in the section the
 * judge named; a «ответа нет» scenario has both `causeChange` and `causeLink` `not_applicable`, a cause scenario
 * neither. Any violation gives `judge_invalid`.
 */
export function checkKeyedForm(
  output: unknown,
  context: KeyedFormContext,
): FormCheckResult<KeyedJudgeForm> {
  const parsed = KeyedJudgeFormSchema.safeParse(output);
  if (!parsed.success) {
    return INVALID;
  }
  const form = parsed.data;
  if (!placementsFitScenario(form, context.scenarioKind)) {
    return INVALID;
  }
  const sectionOf = claimSections(context.answer);
  const named: readonly (readonly [readonly string[], JudgedSection | null])[] =
    [
      [form.causeChangeClaimIds, SECTION_OF_PLACEMENT[form.causeChange]],
      [form.causeLinkClaimIds, SECTION_OF_PLACEMENT[form.causeLink]],
      [
        form.otherCauseClaimIds,
        form.otherCauseEstablished === 'yes' ? 'established' : null,
      ],
      [form.contradictingClaimIds, 'established'],
    ];
  const allInNamedSection = named.every(([claimIds, section]) =>
    claimIds.every(
      (claimId) => section !== null && sectionOf.get(claimId) === section,
    ),
  );
  return allInNamedSection ? { valid: true, form } : INVALID;
}

/** Checks the keyless judge form: one answer from `yes`, `partly`, `no`; anything else gives `judge_invalid`. */
export function checkUnkeyedForm(
  output: unknown,
): FormCheckResult<UnkeyedJudgeForm> {
  const parsed = UnkeyedJudgeFormSchema.safeParse(output);
  return parsed.success ? { valid: true, form: parsed.data } : INVALID;
}

function placementsFitScenario(
  form: KeyedJudgeForm,
  scenarioKind: ScenarioKey['kind'],
): boolean {
  const changeApplies = form.causeChange !== 'not_applicable';
  const linkApplies = form.causeLink !== 'not_applicable';
  return scenarioKind === 'no_cause'
    ? !changeApplies && !linkApplies
    : changeApplies && linkApplies;
}

/** The section each claim id of the answer stands in; `removed` claims are not in the answer. */
function claimSections(answer: JudgedAnswer): Map<string, JudgedSection> {
  return new Map(
    JUDGED_SECTIONS.flatMap((section) =>
      (answer[section] ?? []).map((claim) => [claim.claimId, section] as const),
    ),
  );
}
