import type { ResultForm } from '../agents/result-forms.js';
import type { GroupTable } from '../calibration/group-table.js';
import { ANSWER_DRAFT_FORM } from './forms/answer-draft.js';
import { CLAIM_ASSESSMENT_FORM, claimAssessmentBindings } from './forms/claim-assessment.js';
import { RESEARCH_CLOSE_FORM } from './forms/research-close.js';

/** The result forms of the research process; the engine's assembly adds them to the base forms (ADR-0010). */
export const RESEARCH_FORMS: readonly ResultForm[] = [RESEARCH_CLOSE_FORM, ANSWER_DRAFT_FORM, CLAIM_ASSESSMENT_FORM];

/** The forms with the group tables, keyed by the pair of fingerprints, bound to `claim_assessment`. */
export function bindGroupTables(forms: readonly ResultForm[], tables: readonly GroupTable[]): ResultForm[] {
  return forms.map((form) => (form.name === CLAIM_ASSESSMENT_FORM.name ? { ...form, bindings: claimAssessmentBindings(tables) } : form));
}
