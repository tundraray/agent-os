import type { SourceMode } from '../config/source-check.js';
import { composeAnswer, type DraftClaim, type KnownClaim, type ReferenceCheck, screenDraft } from './reference-gateway.js';

// DC-11 and the rules of AC-09.1, AC-09.3 (UC-7 rule half, mode `sources`): a draft claim without a reference, citing
// evidence that does not exist for the owner or evidence of another investigation is removed with its reason; only a
// `supported` claim is established; a new claim goes to verification while rounds are left and is assumed and
// unverified without them; `answered` without a supported claim is lowered to `inconclusive`.
// Defects caught: the gateway passing a reference to foreign evidence (existence checked without ownership), a new
// claim established when the rounds are exhausted, an unverified claim established, DC-11 not applied.
// Boundary: the reference checks come in as data — the handler reads them through `EvidenceReader` (INT-3 V2).

const OWN = 'e-own';
const FOREIGN = 'e-foreign';
const MISSING = 'e-missing';
const references = new Map<string, ReferenceCheck>([
  [OWN, 'own'],
  [FOREIGN, 'foreign'],
  [MISSING, 'not_found'],
]);

const known = new Map<string, KnownClaim>(
  (
    [
      ['c-supported', 'supported'],
      ['c-refuted', 'refuted'],
      ['c-insufficient', 'insufficient'],
      ['c-unverified', 'unverified'],
    ] as const
  ).map(([claimId, status]) => [claimId, { claimId, text: `stored ${claimId}`, status }]),
);

const cite = (claimId: string | null, ...evidenceIds: string[]): DraftClaim => ({
  claimId,
  text: `draft ${claimId ?? 'new'}`,
  atoms: [{ kind: 'service', value: 'payments' }],
  evidenceIds,
});

/** The result in short: ids per section (with `verified` for assumed), removals with reasons, or the claims to verify. */
function judge(claims: readonly DraftClaim[], verifyRoundsLeft: number, sourceMode: SourceMode = 'sources') {
  const screened = screenDraft({ sourceMode, claims, known, references });
  const result = composeAnswer({
    sourceMode,
    answerId: 'answer',
    draft: { outcome: 'answered', summary: 'summary' },
    screened,
    freshClaimIds: screened.fresh.map((_, index) => `fresh-${index + 1}`),
    verifyRoundsLeft,
    removedClaimId: () => 'removed-new',
  });
  if (result.outcome === 'needs_verification') return { needsVerification: result.claimIds };
  const { answer } = result;
  return {
    outcome: answer.outcome,
    established: answer.established.map((claim) => [claim.claimId, claim.verified, claim.evidenceIds]),
    assumed: answer.assumed.map((claim) => [claim.claimId, claim.verified, claim.evidenceIds]),
    unknown: answer.unknown.map((claim) => claim.claimId),
    removed: answer.removed.map((claim) => [claim.claimId, claim.reason]),
  };
}

const answer = (fields: Readonly<Record<string, unknown>>) => ({
  outcome: 'answered',
  established: [],
  assumed: [],
  unknown: [],
  removed: [],
  ...fields,
});

describe('reference gateway (mode sources): removals, sections and new claims follow DC-11, AC-09.1, AC-09.3', () => {
  it.each<[string, readonly DraftClaim[], number, unknown]>([
    [
      'a supported claim with its own evidence is established; claims without a reference, with unknown or foreign evidence are removed with their reasons',
      [cite('c-supported', OWN), cite('c-unverified'), cite('c-insufficient', OWN, MISSING), cite(null, FOREIGN)],
      0,
      answer({
        established: [['c-supported', true, [OWN]]],
        removed: [
          ['c-unverified', 'no_reference'],
          ['c-insufficient', 'evidence_not_found'],
          ['removed-new', 'foreign_evidence'],
        ],
      }),
    ],
    [
      'a refuted claim is removed, an insufficient one is unknown and an unverified one assumed; answered without supported is inconclusive',
      [cite('c-refuted', OWN), cite('c-insufficient', OWN), cite('c-unverified', OWN)],
      2,
      answer({ outcome: 'inconclusive', assumed: [['c-unverified', false, [OWN]]], unknown: ['c-insufficient'], removed: [['c-refuted', 'refuted']] }),
    ],
    [
      'a new claim with rounds left goes to verification before the answer',
      [cite('c-supported', OWN), cite(null, OWN), cite('c-unknown-id', OWN)],
      1,
      { needsVerification: ['fresh-1', 'fresh-2'] },
    ],
    [
      'a new claim without rounds left is assumed and unverified, never established',
      [cite('c-supported', OWN), cite(null, OWN)],
      0,
      answer({ established: [['c-supported', true, [OWN]]], assumed: [['fresh-1', false, [OWN]]] }),
    ],
  ])('%s', (_, claims, verifyRoundsLeft, expected) => {
    expect(judge(claims, verifyRoundsLeft)).toEqual(expected);
  });
});

// DC-17, AC-25.1 and AC-25.2 (UC-11 rule half, mode `model_knowledge`): every claim without a reference is assumed and
// unverified with no evidence ids, a claim citing any evidence — even evidence that exists — is removed with
// `evidence_not_found`, nothing goes to verification however many rounds are left, and the outcome is `answered` with at
// least one claim left, `inconclusive` otherwise; `established` is empty in every row. Defect caught: DC-11 lowering
// `answered` in this mode, a reference kept, or a claim sent to verification without sources.

describe('reference gateway (mode model_knowledge): claims are assumed, references removed, DC-11 not applied (DC-17)', () => {
  it.each<[string, readonly DraftClaim[], unknown]>([
    [
      'claims without a reference are assumed and unverified, a claim citing evidence is removed, and the answer is answered',
      [cite(null), cite(null, OWN), cite('c-supported')],
      answer({
        assumed: [
          ['fresh-1', false, []],
          ['fresh-2', false, []],
        ],
        removed: [['removed-new', 'evidence_not_found']],
      }),
    ],
    ['a draft without claims is inconclusive', [], answer({ outcome: 'inconclusive' })],
    [
      'a draft whose claims are all removed is inconclusive',
      [cite(null, MISSING), cite(null, FOREIGN)],
      answer({
        outcome: 'inconclusive',
        removed: [
          ['removed-new', 'evidence_not_found'],
          ['removed-new', 'evidence_not_found'],
        ],
      }),
    ],
  ])('%s', (_, claims, expected) => {
    expect(judge(claims, 2, 'model_knowledge')).toEqual(expected);
  });
});
