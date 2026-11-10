import type { ResearchAnswerConfidence } from '@agent-os/contracts';
import { type GroupTable, groupOf } from '../calibration/group-table.js';
import { type ClaimAssessment, ClaimAssessmentSchema, type ClaimProfile, type ClaimType } from './claim-assessment.js';
import type { AtomCheck } from './check-atoms.js';
import { type PointedRecord, type Pointer, pointedRecords } from './pointer.js';

export type DecidedStatus = 'supported' | 'refuted' | 'insufficient' | 'causal';
/** Why a decided claim is `insufficient`; `pointer_invalid` and `needs_narrowing` are decided before the call. */
export type InsufficientReason = 'invalid_assessment' | 'no_support_data';

export interface DecideClaimInput {
  /** The verifier's output as it came, or null when the call gave none in form. */
  readonly assessment: unknown;
  /** A pointer that passed `checkPointer` against `pages`. */
  readonly pointer: Pointer;
  /** `checkAtoms` over the pointer's records: it goes into the profile only, never into the status (KD-2, DC-9). */
  readonly atomCheck: AtomCheck;
  /** The records of each page the pointer names, by page id. */
  readonly pages: ReadonlyMap<string, readonly unknown[]>;
  /** The group table of the investigation's frozen configuration; none — every established claim gets the lowest group. */
  readonly groupTable: GroupTable | undefined;
}

export interface ClaimDecision {
  readonly status: DecidedStatus;
  /** Set only when the status is `insufficient`. */
  readonly reason: InsufficientReason | null;
  /** The type the assessment gave; null when it was not in form. */
  readonly claimType: ClaimType | null;
  /** Page ids the status rests on: of the records marked `supports` (`supported`, `causal`) or `contradicts` (`refuted`). */
  readonly basis: readonly string[];
  /** The atom check the decision was given, as the revision stores its atoms. */
  readonly values: AtomCheck;
  /** Set only when the status is `supported`. */
  readonly profile: ClaimProfile | null;
  readonly confidence: ResearchAnswerConfidence | null;
}

type Relation = ClaimAssessment['records'][number]['relation'];

/**
 * The form rule (DC-7): the schema, a relation for every given record exactly once and for no other number, and at
 * least one `supports` when the answer is `yes`.
 */
function inForm(raw: unknown, given: number): ClaimAssessment | null {
  const parsed = ClaimAssessmentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const numbers = parsed.data.records.map((item) => item.record);
  const inInput = numbers.every((number) => Number.isInteger(number) && number >= 0 && number < given);
  if (!inInput || numbers.length !== given || new Set(numbers).size !== given) return null;
  if (parsed.data.support === 'yes' && !parsed.data.records.some((item) => item.relation === 'supports')) return null;
  return parsed.data;
}

const markedAs = (assessment: ClaimAssessment, records: readonly PointedRecord[], relation: Relation): PointedRecord[] =>
  assessment.records.filter((item) => item.relation === relation).flatMap((item) => records[item.record] ?? []);

const pagesOf = (records: readonly PointedRecord[]): string[] => [...new Set(records.map((item) => item.pageId))];

/** Records with one `traceId` are one source; a record without `traceId` is a source of its own. */
function independentCount(records: readonly PointedRecord[]): number {
  const sources = new Set<unknown>();
  for (const item of records) {
    const traceId = typeof item.record === 'object' && item.record !== null ? (item.record as Record<string, unknown>).traceId : undefined;
    sources.add(typeof traceId === 'string' ? traceId : item);
  }
  return sources.size;
}

/**
 * The status of one claim from the verifier's closed assessment, the pointer, the pointed records and the atom check
 * (design-engine.md, «Как утверждение получает статус», steps 3–6, and «Как считается группа уверенности»). The status
 * depends on the assessment only; the atom check is a feature of the profile (KD-2, Invariant 1). It reads only the
 * assessment's fields, record numbers and typed record fields; the claim text and record text are never read.
 * The closure of `claim_assessment` and calibration both call it, so calibration measures the rule the engine decides by.
 */
export function decideClaim(input: DecideClaimInput): ClaimDecision {
  const records = pointedRecords(input.pointer, input.pages);
  const decided = (fields: Partial<ClaimDecision> & Pick<ClaimDecision, 'status'>): ClaimDecision => ({
    reason: null,
    claimType: null,
    basis: [],
    values: input.atomCheck,
    profile: null,
    confidence: null,
    ...fields,
  });

  const assessment = inForm(input.assessment, records.length);
  if (assessment === null) return decided({ status: 'insufficient', reason: 'invalid_assessment' });
  const { claimType } = assessment;
  const supporting = markedAs(assessment, records, 'supports');
  if (claimType === 'causal') return decided({ status: 'causal', claimType, basis: pagesOf(supporting) });
  if (assessment.support === 'no') {
    return decided({ status: 'refuted', claimType, basis: pagesOf(markedAs(assessment, records, 'contradicts')) });
  }
  if (assessment.support === 'insufficient') return decided({ status: 'insufficient', reason: 'no_support_data', claimType });

  const profile: ClaimProfile = {
    claimType,
    valueCheck: input.atomCheck.valueCheck,
    independentRecords: independentCount(supporting) >= 2 ? 'two_or_more' : 'one',
    contradictions: assessment.records.some((item) => item.relation === 'contradicts'),
  };
  return decided({
    status: 'supported',
    claimType,
    basis: pagesOf(supporting),
    profile,
    confidence: groupOf(input.groupTable, profile),
  });
}
