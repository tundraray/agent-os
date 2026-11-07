import type { SourceMode } from '../config/source-check.js';
import { composeAnswer, type DraftClaim, type KnownClaim, type ReferenceCheck, screenDraft } from './reference-gateway.js';

// DC-11 and the rules of AC-09.1, AC-09.3 (UC-7 rule half, mode `sources`): a new draft claim without a reference, citing
// evidence that does not exist for the owner, evidence of another investigation or a record no input claim points at
// is removed with its reason; only a
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
  ['basis-c-unverified', 'own'],
]);

// The stored latest revisions. Each rests on pages of its own (`basis-…`) that no draft cites, so a reference taken from
// the draft instead of the stored basis shows (DC-4); each has a stored text no draft writes. The stored pages of an
// unverified claim are checked by the gateway, so its basis is an own page. The input claims' pointers name records
// 0–2 and 5 of OWN: the only records a new claim may rest on (Flow 2).
const stored = (
  claimId: string,
  status: string,
  { confidence = null, evidenceIds = [`basis-${claimId}`], pointer = null }: Partial<Pick<KnownClaim, 'confidence' | 'evidenceIds' | 'pointer'>> = {},
): [string, KnownClaim] => [claimId, { claimId, text: `stored ${claimId}`, status, evidenceIds, confidence, pointer }];
const known = new Map<string, KnownClaim>([
  stored('c-supported', 'supported', { confidence: 'high' }),
  stored('c-supported-2', 'supported', { confidence: 'medium' }),
  stored('c-supported-3', 'supported', { confidence: 'low' }),
  stored('c-supported-4', 'supported', { confidence: 'high' }),
  stored('c-supported-old', 'supported'),
  stored('c-causal', 'causal', { pointer: [{ pageId: OWN, records: [5] }] }),
  stored('c-refuted', 'refuted'),
  stored('c-insufficient', 'insufficient', { pointer: [{ pageId: OWN, records: [0, 1, 2] }] }),
  // An insufficient revision decided without a call (`pointer_invalid`): a pointer to foreign evidence, no basis.
  stored('c-insufficient-invalid', 'insufficient', { evidenceIds: [], pointer: [{ pageId: FOREIGN, records: [0] }] }),
  stored('c-unverified', 'unverified'),
  stored('c-unverified-foreign', 'unverified', { evidenceIds: [FOREIGN] }),
  stored('c-unverified-missing', 'unverified', { evidenceIds: [MISSING] }),
]);

/** A draft claim whose pointer names record 0 of each of `pages`. */
const cite = (claimId: string | null, ...pages: string[]): DraftClaim => ({
  claimId,
  text: `draft ${claimId ?? 'new'}`,
  atoms: [{ kind: 'service', value: 'payments' }],
  pointer: pages.map((pageId) => ({ pageId, records: [0] })),
});

/** A new draft claim with this pointer. */
const point = (pointer: DraftClaim['pointer']): DraftClaim => ({ ...cite(null), pointer });

interface Judged {
  readonly verifyRoundsLeft?: number;
  readonly sourceMode?: SourceMode;
  readonly summaryClaimIds?: readonly string[];
}

/**
 * The result in short: per section the id, `verified`, the references and the group (established) or the causal flag
 * (assumed); the summary items; removals with reasons; or the claims to verify.
 */
function judge(claims: readonly DraftClaim[], { verifyRoundsLeft = 0, sourceMode = 'sources', summaryClaimIds = [] }: Judged = {}) {
  const screened = screenDraft({ sourceMode, claims, known, references });
  const result = composeAnswer({
    sourceMode,
    answerId: 'answer',
    draft: { outcome: 'answered', summaryClaimIds },
    screened,
    freshClaimIds: screened.fresh.map((_, index) => `fresh-${index + 1}`),
    verifyRoundsLeft,
    removedClaimId: () => 'removed-new',
  });
  if (result.outcome === 'needs_verification') return { needsVerification: result.claimIds };
  const { answer } = result;
  expect(answer.summary).toBeNull();
  return {
    outcome: answer.outcome,
    established: answer.established.map((claim) => [claim.claimId, claim.verified, claim.evidenceIds, claim.confidence]),
    assumed: answer.assumed.map((claim) => [claim.claimId, claim.verified, claim.evidenceIds, claim.causal]),
    unknown: answer.unknown.map((claim) => [claim.claimId, claim.evidenceIds]),
    summary: answer.summaryItems.map((item) => [item.claimId, item.text, item.confidence]),
    removed: answer.removed.map((claim) => [claim.claimId, claim.reason]),
  };
}

const answer = (fields: Readonly<Record<string, unknown>>) => ({
  outcome: 'answered',
  established: [],
  assumed: [],
  unknown: [],
  summary: [],
  removed: [],
  ...fields,
});

describe('reference gateway (mode sources): removals, sections and new claims follow DC-11, AC-09.1, AC-09.3', () => {
  it.each<[string, readonly DraftClaim[], number, unknown]>([
    [
      'a supported claim is established; new claims without a reference, with unknown or foreign evidence are removed with their reasons',
      [cite('c-supported', OWN), cite(null), cite(null, OWN, MISSING), cite(null, FOREIGN)],
      0,
      answer({
        established: [['c-supported', true, ['basis-c-supported'], 'high']],
        removed: [
          ['removed-new', 'no_reference'],
          ['removed-new', 'evidence_not_found'],
          ['removed-new', 'foreign_evidence'],
        ],
      }),
    ],
    [
      'answered without a supported claim is lowered to inconclusive',
      [cite('c-insufficient', OWN), cite('c-unverified', OWN)],
      2,
      answer({
        outcome: 'inconclusive',
        assumed: [['c-unverified', false, ['basis-c-unverified'], false]],
        unknown: [['c-insufficient', []]],
      }),
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
      answer({
        established: [['c-supported', true, ['basis-c-supported'], 'high']],
        assumed: [['fresh-1', false, [OWN], false]],
      }),
    ],
    // KD-1, AC-11.1 (data half): a new claim's pages are the pages of its pointer, each once. Defect caught: the pages
    // of a new claim taken from anywhere but its pointer, or a page it names twice kept twice.
    [
      'a new claim is judged by the pages of its pointer: its own pages pass once each, a foreign or unknown page removes it',
      [
        point([{ pageId: OWN, records: [0, 2] }, { pageId: OWN, records: [5] }]),
        point([{ pageId: OWN, records: [1] }, { pageId: FOREIGN, records: [0] }]),
        point([{ pageId: OWN, records: [1] }, { pageId: MISSING, records: [3] }]),
        point([]),
      ],
      0,
      answer({
        outcome: 'inconclusive',
        assumed: [['fresh-1', false, [OWN], false]],
        removed: [
          ['removed-new', 'foreign_evidence'],
          ['removed-new', 'evidence_not_found'],
          ['removed-new', 'no_reference'],
        ],
      }),
    ],
    // Flow 2: a new claim may rest only on the records the input claims point at. Defect caught: a new claim resting on a
    // record of an own page that no input claim names passes the gateway as if the investigation had pointed at it.
    [
      'a new claim resting on a record of an own page that no input claim points at is removed as foreign evidence',
      [point([{ pageId: OWN, records: [2, 5] }]), point([{ pageId: OWN, records: [1, 7] }])],
      0,
      answer({
        outcome: 'inconclusive',
        assumed: [['fresh-1', false, [OWN], false]],
        removed: [['removed-new', 'foreign_evidence']],
      }),
    ],
  ])('%s', (_, claims, verifyRoundsLeft, expected) => {
    expect(judge(claims, { verifyRoundsLeft })).toEqual(expected);
  });
});

// KD-4, DC-4, AC-14.1, invariants 2 and 3: an input claim goes by the status of its latest revision whatever pointer the
// draft gives it, and keeps its stored text and stored pages — for an established claim the basis of its check, with its
// group; an unknown claim cites nothing. Defects caught: an input claim removed or placed by its draft pointer, a
// reference taken from the draft, a causal claim established or marked unverified, a recomputed group, a refuted claim
// kept, an unverified claim delivered on stored pages that are not this investigation's.
describe('reference gateway (mode sources): an input claim goes to the section of its status with its stored basis (KD-4, DC-4)', () => {
  it.each<[string, readonly DraftClaim[], unknown]>([
    [
      'places each of the five statuses by the stored revision, whatever pages the draft names for it',
      [cite('c-supported', FOREIGN), cite('c-causal'), cite('c-insufficient', MISSING), cite('c-unverified', FOREIGN), cite('c-refuted', OWN)],
      answer({
        established: [['c-supported', true, ['basis-c-supported'], 'high']],
        assumed: [
          ['c-causal', true, ['basis-c-causal'], true],
          ['c-unverified', false, ['basis-c-unverified'], false],
        ],
        unknown: [['c-insufficient', []]],
        removed: [['c-refuted', 'refuted']],
      }),
    ],
    [
      'an insufficient claim whose stored pointer is invalid lands in unknown',
      [cite('c-insufficient-invalid', OWN), cite('c-supported', OWN)],
      answer({ established: [['c-supported', true, ['basis-c-supported'], 'high']], unknown: [['c-insufficient-invalid', []]] }),
    ],
    [
      'an unverified claim whose stored page is foreign or missing is removed with its reason, even when its draft pointer is own',
      [cite('c-unverified-foreign', OWN), cite('c-unverified-missing', OWN), cite('c-supported', OWN)],
      answer({
        established: [['c-supported', true, ['basis-c-supported'], 'high']],
        removed: [
          ['c-unverified-foreign', 'foreign_evidence'],
          ['c-unverified-missing', 'evidence_not_found'],
        ],
      }),
    ],
  ])('%s', (_, claims, expected) => {
    expect(judge(claims)).toEqual(expected);
  });

  it('refuses a status outside the closed list instead of placing the claim by guess', () => {
    const disputed = new Map(known).set('c-disputed', { ...known.get('c-unverified')!, claimId: 'c-disputed', status: 'disputed' });

    expect(() => screenDraft({ sourceMode: 'sources', claims: [cite('c-disputed', OWN)], known: disputed, references })).toThrow(
      'claim c-disputed has the unknown status disputed',
    );
  });
});

// KD-4, DC-12, AC-16.1–AC-16.3, invariant 4: of the ids synthesis chose, the summary keeps only claims established in
// this answer, in the order chosen, each once, at most three; an item is the claim's stored text and group. Defects
// caught: the model's text in an item, a causal or unverified claim in the summary, an invented id kept, a repeat
// counted or kept twice, a fourth item, the order of the sections instead of the order chosen.
describe('summary items (mode sources): only accepted claims of this answer, in the order chosen, at most three (DC-12)', () => {
  const draft = [
    ...['c-supported', 'c-supported-2', 'c-supported-3', 'c-supported-4', 'c-supported-old'].map((claimId) => cite(claimId, OWN)),
    ...['c-causal', 'c-insufficient', 'c-unverified', 'c-refuted'].map((claimId) => cite(claimId, OWN)),
    cite(null, OWN),
  ];
  const item = (claimId: string, confidence: string) => [claimId, `stored ${claimId}`, confidence];

  it.each<[string, readonly string[], readonly unknown[]]>([
    ['in the order chosen', ['c-supported-3', 'c-supported'], [item('c-supported-3', 'low'), item('c-supported', 'high')]],
    [
      'a repeat is kept once and does not count toward the limit',
      ['c-supported-2', 'c-supported-2', 'c-supported-2', 'c-supported', 'c-supported-4'],
      [item('c-supported-2', 'medium'), item('c-supported', 'high'), item('c-supported-4', 'high')],
    ],
    [
      'a fourth accepted claim is left out',
      ['c-supported', 'c-supported-2', 'c-supported-3', 'c-supported-4'],
      [item('c-supported', 'high'), item('c-supported-2', 'medium'), item('c-supported-3', 'low')],
    ],
    [
      'a causal, unknown, unverified, refuted or new claim is not accepted and is dropped',
      ['c-causal', 'c-insufficient', 'c-unverified', 'c-refuted', 'fresh-1', 'c-supported-2'],
      [item('c-supported-2', 'medium')],
    ],
    ['an id of no claim is dropped', ['c-invented', 'c-supported'], [item('c-supported', 'high')]],
    ['a supported claim without a group (written before agent-quality) gives no item', ['c-supported-old'], []],
    ['no chosen id: no summary', [], []],
    ['only ids that are not accepted: no summary', ['c-causal', 'c-invented'], []],
  ])('%s', (_, summaryClaimIds, summary) => {
    expect(judge(draft, { summaryClaimIds }).summary).toEqual(summary);
  });
});

// DC-17, AC-25.1 and AC-25.2 (UC-11 rule half, mode `model_knowledge`): every claim without a reference is assumed and
// unverified with no evidence ids, a claim citing any evidence — even evidence that exists — is removed with
// `evidence_not_found`, nothing goes to verification however many rounds are left, and the outcome is `answered` with at
// least one claim left, `inconclusive` otherwise; `established` is empty in every row, and so is the summary whatever
// synthesis chose (DC-13). Defect caught: DC-11 lowering `answered` in this mode, a reference kept, a claim sent to
// verification without sources, or a summary item without sources.

describe('reference gateway (mode model_knowledge): claims are assumed, references removed, DC-11 not applied, no summary (DC-17, DC-13)', () => {
  it.each<[string, readonly DraftClaim[], unknown]>([
    [
      'claims without a reference are assumed and unverified, a claim citing evidence is removed, and the answer is answered',
      [cite(null), cite(null, OWN), cite('c-supported')],
      answer({
        assumed: [
          ['fresh-1', false, [], false],
          ['fresh-2', false, [], false],
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
    expect(judge(claims, { verifyRoundsLeft: 2, sourceMode: 'model_knowledge', summaryClaimIds: ['c-supported', 'fresh-1'] })).toEqual(
      expected,
    );
  });
});
