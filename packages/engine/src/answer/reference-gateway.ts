import type { WorkerClaim } from '../claims/claim.schema.js';
import type { SourceMode } from '../config/source-check.js';
import type { InvestigationAnswer } from './code-answer.js';

/** A claim of the synthesis draft: an input claim by its `claimId`, or a new one (`claimId` null) with its atoms. */
export interface DraftClaim extends WorkerClaim {
  readonly claimId: string | null;
}

/** The synthesis draft the gateway judges (Flow 3). */
export interface SynthesisDraft {
  readonly outcome: InvestigationAnswer['outcome'];
  readonly summary: string;
  readonly claims: readonly DraftClaim[];
}

/** The latest revision of a claim of the investigation. */
export interface KnownClaim {
  readonly claimId: string;
  readonly text: string;
  readonly status: string;
}

/**
 * What code found behind a cited evidence id: evidence of a task of this investigation (`own`), evidence of another
 * investigation of the same owner (`foreign`), or none for this owner (`not_found`).
 */
export type ReferenceCheck = 'own' | 'foreign' | 'not_found';

/** Why the gateway removed a claim from the answer (AC-09.1); the reason is recorded in `removed`. */
export type RemovalReason = 'no_reference' | 'evidence_not_found' | 'foreign_evidence' | 'refuted';

type AnswerClaim = InvestigationAnswer['established'][number];
type Section = 'established' | 'assumed' | 'unknown';

/** A draft screened by the gateway: removed claims, input claims kept with their section, and new claims. */
export interface ScreenedDraft {
  readonly removed: readonly { readonly claimId: string | null; readonly text: string; readonly reason: RemovalReason }[];
  readonly kept: readonly { readonly section: Section; readonly claim: AnswerClaim }[];
  /** New claims with admissible references, in draft order; the synthesis task writes them as `unverified` revisions. */
  readonly fresh: readonly DraftClaim[];
}

export interface ScreenInput {
  /** The investigation's recorded mode (DC-16): it picks the rules of the gateway. */
  readonly sourceMode: SourceMode;
  readonly claims: readonly DraftClaim[];
  readonly known: ReadonlyMap<string, KnownClaim>;
  /** The check of every evidence id the draft cites; an id without an entry counts as `not_found`. */
  readonly references: ReadonlyMap<string, ReferenceCheck>;
}

/** The section of an input claim by its latest status; null when the claim leaves the answer. */
function sectionOf(status: string): Section | null {
  switch (status) {
    case 'supported':
      return 'established';
    case 'refuted':
      return null;
    case 'insufficient':
      // Verified and not confirmed by the records: what the investigation could not establish.
      return 'unknown';
    default:
      return 'assumed';
  }
}

function referenceFault(evidenceIds: readonly string[], references: ScreenInput['references']): RemovalReason | null {
  if (evidenceIds.length === 0) return 'no_reference';
  for (const evidenceId of evidenceIds) {
    const check = references.get(evidenceId) ?? 'not_found';
    if (check === 'not_found') return 'evidence_not_found';
    if (check === 'foreign') return 'foreign_evidence';
  }
  return null;
}

/**
 * DC-17: without sources there is no evidence to cite, so a claim citing any evidence id is removed with
 * `evidence_not_found`, and every other claim is new — the answer delivers it as assumed knowledge of the model.
 */
function screenWithoutSources(claims: readonly DraftClaim[]): ScreenedDraft {
  const removed: ScreenedDraft['removed'][number][] = [];
  const fresh: DraftClaim[] = [];
  for (const claim of claims) {
    if (claim.evidenceIds.length > 0) {
      removed.push({ claimId: null, text: claim.text, reason: 'evidence_not_found' });
    } else {
      fresh.push(claim);
    }
  }
  return { removed, kept: [], fresh };
}

/**
 * The reference gateway (design-engine.md, Flow 3, KD-6); in the mode `model_knowledge` see {@link screenWithoutSources}.
 * Mode `sources`: a claim without a reference, citing
 * evidence that does not exist for the owner or evidence of another investigation is removed with its reason
 * (AC-09.1); an input claim keeps its stored text and goes to the section of its status — `established` only when
 * `supported` (invariant 8), a `refuted` one is removed; a claim the draft adds is new and is judged by
 * {@link composeAnswer}.
 */
export function screenDraft(input: ScreenInput): ScreenedDraft {
  if (input.sourceMode === 'model_knowledge') return screenWithoutSources(input.claims);
  const removed: ScreenedDraft['removed'][number][] = [];
  const kept: ScreenedDraft['kept'][number][] = [];
  const fresh: DraftClaim[] = [];
  for (const claim of input.claims) {
    const known = claim.claimId === null ? undefined : input.known.get(claim.claimId);
    const fault = referenceFault(claim.evidenceIds, input.references);
    if (fault !== null) {
      removed.push({ claimId: known?.claimId ?? null, text: known?.text ?? claim.text, reason: fault });
      continue;
    }
    if (known === undefined) {
      fresh.push(claim);
      continue;
    }
    const section = sectionOf(known.status);
    if (section === null) {
      removed.push({ claimId: known.claimId, text: known.text, reason: 'refuted' });
      continue;
    }
    kept.push({
      section,
      claim: { claimId: known.claimId, text: known.text, evidenceIds: [...claim.evidenceIds], verified: section === 'established' },
    });
  }
  return { removed, kept, fresh };
}

export type GatewayResult =
  /** New claims go to verification before the answer (AC-09.3): the task succeeds with this sign, no answer. */
  | { readonly outcome: 'needs_verification'; readonly claimIds: readonly string[] }
  | { readonly outcome: 'answer'; readonly answer: InvestigationAnswer };

/**
 * The answer of a screened draft, or `needs_verification` (AC-09.3): new claims — written with `freshClaimIds`, in
 * draft order — are verified first while rounds are left, and without rounds they are `assumed` and unverified, never
 * `established`. Mode `sources` (DC-11): `answered` without a `supported` claim is lowered to `inconclusive`. Mode
 * `model_knowledge` (KD-8, DC-17): nothing is verified, every claim is assumed, and the outcome is `answered` when at
 * least one claim is left, `inconclusive` otherwise; DC-11 does not apply. A removed new claim was never written, so its
 * entry in `removed` gets an id of its own from `removedClaimId`.
 */
export function composeAnswer(input: {
  readonly sourceMode: SourceMode;
  readonly answerId: string;
  readonly draft: Pick<SynthesisDraft, 'outcome' | 'summary'>;
  readonly screened: ScreenedDraft;
  readonly freshClaimIds: readonly string[];
  readonly verifyRoundsLeft: number;
  readonly removedClaimId: () => string;
}): GatewayResult {
  const { screened, freshClaimIds } = input;
  const withoutSources = input.sourceMode === 'model_knowledge';
  if (!withoutSources && freshClaimIds.length > 0 && input.verifyRoundsLeft > 0) {
    return { outcome: 'needs_verification', claimIds: freshClaimIds };
  }
  const inSection = (section: Section) => screened.kept.filter((item) => item.section === section).map((item) => item.claim);
  const established = inSection('established');
  const assumedFresh = screened.fresh.map((claim, index) => ({
    claimId: freshClaimIds[index]!,
    text: claim.text,
    evidenceIds: [...claim.evidenceIds],
    verified: false,
  }));
  const assumed = [...inSection('assumed'), ...assumedFresh];
  let outcome: InvestigationAnswer['outcome'];
  if (withoutSources) {
    outcome = assumed.length > 0 ? 'answered' : 'inconclusive';
  } else {
    outcome = input.draft.outcome === 'answered' && established.length === 0 ? 'inconclusive' : input.draft.outcome;
  }
  return {
    outcome: 'answer',
    answer: {
      answerId: input.answerId,
      outcome,
      stopReason: null,
      summary: input.draft.summary,
      established,
      assumed,
      unknown: inSection('unknown'),
      removed: screened.removed.map((item) => ({ claimId: item.claimId ?? input.removedClaimId(), text: item.text, reason: item.reason })),
    },
  };
}
