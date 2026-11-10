import type { ResearchAnswerConfidence } from '@agent-os/contracts';
import { pointerPages, type WorkerClaim } from '../claims/claim.schema.js';
import type { SourceMode } from '../config/source-check.js';
import { type Pointer, PointerSchema } from '../verify/pointer.js';
import { type InvestigationAnswer, SUMMARY_ITEMS_MAX } from './code-answer.js';

/**
 * A claim of the synthesis draft: an input claim by its `claimId`, or a new one (`claimId` null) with its atoms. Its
 * references are the pages of its pointer.
 */
export interface DraftClaim extends WorkerClaim {
  readonly claimId: string | null;
}

/** The synthesis draft the gateway judges (Flow 2). */
export interface SynthesisDraft {
  readonly outcome: InvestigationAnswer['outcome'];
  /** The claims the model chose for the summary, most important first; code keeps only accepted ones (DC-12). */
  readonly summaryClaimIds: readonly string[];
  readonly claims: readonly DraftClaim[];
}

/** The latest revision of a claim of the investigation, as stored. */
export interface KnownClaim {
  readonly claimId: string;
  readonly text: string;
  readonly status: string;
  /** The pages the revision rests on: the basis of a check revision, the pointer's pages of a first one. */
  readonly evidenceIds: readonly string[];
  /** The group of a `supported` revision; null for every other status. */
  readonly confidence: ResearchAnswerConfidence | null;
  /** The pointer as stored; null on revisions written before agent-quality. New draft claims may rest only on its records. */
  readonly pointer: unknown;
}

/**
 * What code found behind a page a draft claim's pointer names: evidence of a task of this investigation (`own`), evidence of another
 * investigation of the same owner (`foreign`), or none for this owner (`not_found`).
 */
export type ReferenceCheck = 'own' | 'foreign' | 'not_found';

/** Why the gateway removed a claim from the answer (AC-09.1); the reason is recorded in `removed`. */
export type RemovalReason = 'no_reference' | 'evidence_not_found' | 'foreign_evidence' | 'refuted';

/** A draft screened by the gateway: removed claims, input claims kept in the section of their status, and new claims. */
export interface ScreenedDraft {
  readonly removed: readonly { readonly claimId: string | null; readonly text: string; readonly reason: RemovalReason }[];
  readonly established: InvestigationAnswer['established'];
  readonly assumed: InvestigationAnswer['assumed'];
  readonly unknown: InvestigationAnswer['unknown'];
  /** New claims with admissible references, in draft order; the synthesis task writes them as `unverified` revisions. */
  readonly fresh: readonly DraftClaim[];
}

export interface ScreenInput {
  /** The investigation's recorded mode (DC-16): it picks the rules of the gateway. */
  readonly sourceMode: SourceMode;
  readonly claims: readonly DraftClaim[];
  readonly known: ReadonlyMap<string, KnownClaim>;
  /**
   * The check of every page the draft references — the stored pages of each input claim it names (its draft pointer is
   * never read) and the pointer pages of each new claim; a page without an entry counts as `not_found`.
   */
  readonly references: ReadonlyMap<string, ReferenceCheck>;
}

type Placement = 'established' | 'causal' | 'unknown' | 'unverified' | 'removed';

/**
 * Where an input claim goes by its latest status. The list of statuses is closed: a status outside it is a defect, not
 * a claim to place by guess.
 */
function placementOf(known: KnownClaim): Placement {
  switch (known.status) {
    case 'supported':
      return 'established';
    case 'causal':
      // Verified, but the records do not show a causal link: assumed with its mark, never established (invariant 2).
      return 'causal';
    case 'insufficient':
      // Verified and not confirmed by the records: what the investigation could not establish.
      return 'unknown';
    case 'unverified':
      return 'unverified';
    case 'refuted':
      return 'removed';
    default:
      throw new Error(`claim ${known.claimId} has the unknown status ${known.status}`);
  }
}

function referenceFault(pages: readonly string[], references: ScreenInput['references']): RemovalReason | null {
  if (pages.length === 0) return 'no_reference';
  for (const pageId of pages) {
    const check = references.get(pageId) ?? 'not_found';
    if (check === 'not_found') return 'evidence_not_found';
    if (check === 'foreign') return 'foreign_evidence';
  }
  return null;
}

const recordKey = (pageId: string, record: number): string => JSON.stringify([pageId, record]);

/** The (page, record) pairs the input claims' stored pointers name; a pointer not in form names none. */
function inputRecords(known: ScreenInput['known']): ReadonlySet<string> {
  const records = new Set<string>();
  for (const claim of known.values()) {
    const pointer = PointerSchema.safeParse(claim.pointer);
    if (!pointer.success) continue;
    for (const { pageId, records: numbers } of pointer.data) {
      for (const number of numbers) records.add(recordKey(pageId, number));
    }
  }
  return records;
}

/**
 * A new claim may rest only on records the input claims' pointers name (Flow 2): a record outside them on an own page
 * is evidence the investigation never pointed at, so the claim is removed as `foreign_evidence`.
 */
function outsideInput(pointer: Pointer, allowed: ReadonlySet<string>): boolean {
  return pointer.some(({ pageId, records }) => records.some((number) => !allowed.has(recordKey(pageId, number))));
}

/** The stored revision of a draft claim that names an input claim; undefined for a new claim. */
const knownOf = (claim: DraftClaim, known: ScreenInput['known']): KnownClaim | undefined =>
  claim.claimId === null ? undefined : known.get(claim.claimId);

/**
 * DC-17: without sources there is no evidence to cite, so a claim whose pointer names any page is removed with
 * `evidence_not_found`, and every other claim is new — the answer delivers it as assumed knowledge of the model.
 */
function screenWithoutSources(claims: readonly DraftClaim[]): ScreenedDraft {
  const removed: ScreenedDraft['removed'][number][] = [];
  const fresh: DraftClaim[] = [];
  for (const claim of claims) {
    if (pointerPages(claim.pointer).length > 0) {
      removed.push({ claimId: null, text: claim.text, reason: 'evidence_not_found' });
    } else {
      fresh.push(claim);
    }
  }
  return { removed, established: [], assumed: [], unknown: [], fresh };
}

/**
 * The reference gateway (design-engine.md, Flow 2, KD-4); in the mode `model_knowledge` see {@link screenWithoutSources}.
 * Mode `sources`. An input claim (a known `claimId`) is placed by the status of its latest revision, never removed for
 * the pointer the draft gives it, and keeps its stored text: `supported` to `established` with the basis of its check
 * and its group (DC-4), `causal` to `assumed` marked causal and verified, `insufficient` to `unknown` without
 * references, `unverified` to `assumed` unverified with its stored pages; a `refuted` one is removed. The stored pages
 * of an `unverified` claim were never checked, so a page of them that is not this investigation's removes it with its
 * reason; the basis of a `supported` or `causal` claim was checked by the checker agent (`claim_assessment`). A new claim (`claimId` null or
 * unknown) is removed when its pointer names no page, a page that does not exist for the owner, a page of another
 * investigation or a record no input claim's pointer names (AC-09.1); otherwise it is judged by {@link composeAnswer}.
 */
export function screenDraft(input: ScreenInput): ScreenedDraft {
  if (input.sourceMode === 'model_knowledge') return screenWithoutSources(input.claims);
  const removed: ScreenedDraft['removed'][number][] = [];
  const established: InvestigationAnswer['established'][number][] = [];
  const assumed: InvestigationAnswer['assumed'][number][] = [];
  const unknown: InvestigationAnswer['unknown'][number][] = [];
  const fresh: DraftClaim[] = [];
  const allowed = inputRecords(input.known);
  for (const claim of input.claims) {
    const known = knownOf(claim, input.known);
    if (known === undefined) {
      const fault = referenceFault(pointerPages(claim.pointer), input.references);
      const reason = fault ?? (outsideInput(claim.pointer, allowed) ? 'foreign_evidence' : null);
      if (reason === null) fresh.push(claim);
      else removed.push({ claimId: null, text: claim.text, reason });
      continue;
    }
    const stored = { claimId: known.claimId, text: known.text, evidenceIds: [...known.evidenceIds] };
    switch (placementOf(known)) {
      case 'established':
        established.push({ ...stored, verified: true, confidence: known.confidence });
        break;
      case 'causal':
        assumed.push({ ...stored, verified: true, causal: true });
        break;
      case 'unverified': {
        const fault = referenceFault(known.evidenceIds, input.references);
        if (fault === null) assumed.push({ ...stored, verified: false, causal: false });
        else removed.push({ claimId: known.claimId, text: known.text, reason: fault });
        break;
      }
      case 'unknown':
        unknown.push({ ...stored, evidenceIds: [], verified: false });
        break;
      case 'removed':
        removed.push({ claimId: known.claimId, text: known.text, reason: 'refuted' });
        break;
    }
  }
  return { removed, established, assumed, unknown, fresh };
}

/**
 * The summary items (design-engine.md, «Как собирается сводка», DC-12): of the ids synthesis chose, only claims
 * established in this answer, in the order chosen, each once, at most three; an item is the claim's stored text and
 * group. An id of a claim assumed, unknown, removed or never written is dropped; so is an established claim without a
 * group, which only a revision written before agent-quality can be.
 */
function summaryItemsOf(
  chosen: readonly string[],
  established: InvestigationAnswer['established'],
): InvestigationAnswer['summaryItems'] {
  const byId = new Map(established.map((claim) => [claim.claimId, claim]));
  const items: InvestigationAnswer['summaryItems'][number][] = [];
  const taken = new Set<string>();
  for (const claimId of chosen) {
    if (items.length === SUMMARY_ITEMS_MAX) break;
    const claim = byId.get(claimId);
    if (claim === undefined || claim.confidence === null || taken.has(claimId)) continue;
    taken.add(claimId);
    items.push({ claimId, text: claim.text, confidence: claim.confidence });
  }
  return items;
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
 * least one claim is left, `inconclusive` otherwise; DC-11 does not apply, and with nothing established there is no
 * summary (DC-13). The summary items come from {@link summaryItemsOf}; `summary` is null. A removed new claim was never
 * written, so its entry in `removed` gets an id of its own from `removedClaimId`.
 */
export function composeAnswer(input: {
  readonly sourceMode: SourceMode;
  readonly answerId: string;
  readonly draft: Pick<SynthesisDraft, 'outcome' | 'summaryClaimIds'>;
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
  const { established } = screened;
  const assumedFresh = screened.fresh.map((claim, index) => ({
    claimId: freshClaimIds[index]!,
    text: claim.text,
    evidenceIds: pointerPages(claim.pointer),
    verified: false,
    causal: false,
  }));
  const assumed = [...screened.assumed, ...assumedFresh];
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
      summary: null,
      summaryItems: summaryItemsOf(input.draft.summaryClaimIds, established),
      established,
      assumed,
      unknown: screened.unknown,
      removed: screened.removed.map((item) => ({ claimId: item.claimId ?? input.removedClaimId(), text: item.text, reason: item.reason })),
    },
  };
}
