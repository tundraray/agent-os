import type { GroupTable } from '../calibration/group-table.js';
import { type Atom, checkAtoms } from './check-atoms.js';
import type { ClaimProfile } from './claim-assessment.js';
import { type ClaimDecision, type DecideClaimInput, decideClaim } from './decide-claim.js';
import { type Pointer, pointedRecords } from './pointer.js';

// DC-7, DC-9, DC-10, DC-11, UC-2, UC-3, UC-E7 (AC-12.1, AC-12.2, AC-13.1, AC-14.1, AC-15.1; KD-2): the model assesses,
// the algorithm decides, and the atom check only enters the profile. Defects caught: `supported` with an off-form
// assessment; a causal claim established; the atom check setting the status (a `yes` dropped or a `no` overturned by
// it, a reason for missing values); a profile without `unmatched`; the atom check run over a page record outside the
// pointer; two rows of one trace counted as two independent records; a group that is not the table's.

const TRACE_A = 'a'.repeat(32);
const TRACE_B = 'b'.repeat(32);
const bucket = (count: number) => ({ start: '2026-10-01T12:00:00.000Z', key: 'payments', count });
const log = (ts: string, traceId?: string) => ({ ts, service: 'payments', event: 'refund', ...(traceId === undefined ? {} : { traceId }) });
/** A count group of `aggregate_logs` grouped by event, as in UC-3. */
const timeoutGroup = (count: number) => ({ start: '2026-10-01T19:00:00.000Z', key: 'timeout', count });

/** `pCount` record 2 is outside every pointer below but one: only that pointer finds the count 7. */
const PAGES = new Map<string, readonly unknown[]>([
  ['pCount', [bucket(40), bucket(2), bucket(7)]],
  ['pLogs', [log('2026-10-01T12:05:00Z', TRACE_A), log('2026-10-01T12:06:00Z', TRACE_B), log('2026-10-01T12:07:00Z', TRACE_A), log('2026-10-01T12:08:00Z')]],
  ['pTimeout380', [timeoutGroup(380)]],
  ['pTimeout412', [timeoutGroup(412)]],
]);

/** Input records 0, 1 — the two counted buckets; 2, 3 — log rows of traces A and B. */
const COUNTS_AND_LOGS: Pointer = [
  { pageId: 'pCount', records: [0, 1] },
  { pageId: 'pLogs', records: [0, 1] },
];
/** Both found in the pointed records: the service in every record, the count 40 in the first bucket. */
const COUNT_40: Atom[] = [{ kind: 'text', value: 'payments' }, { kind: 'number', value: '40' }];
/** UC-3: «from 19:00 to 20:00 there were 412 timeouts». */
const TIMEOUTS_412: Atom[] = [
  { kind: 'text', value: 'timeout' },
  { kind: 'number', value: '412' },
  { kind: 'time', value: '2026-10-01T19:00:00.000Z/2026-10-01T20:00:00.000Z' },
];

const profile = (fields: Pick<ClaimProfile, 'independentRecords' | 'contradictions'> & Partial<ClaimProfile>): ClaimProfile => ({
  claimType: 'observation',
  valueCheck: 'not_applicable',
  ...fields,
});

const TABLE: GroupTable = {
  model: 'anthropic/claude-haiku-4-5',
  promptVersion: '0123456789ab',
  scenarioSet: 'first',
  pairsFingerprint: 'ba9876543210',
  calibratedAt: '2026-11-07T10:00:00.000Z',
  groupCount: 3,
  profiles: [
    { profile: profile({ claimType: 'quantitative', valueCheck: 'matched', independentRecords: 'two_or_more', contradictions: false }), group: 'high' },
    { profile: profile({ independentRecords: 'one', contradictions: false }), group: 'medium' },
    { profile: profile({ independentRecords: 'two_or_more', contradictions: false }), group: 'high' },
  ],
  groups: [],
  pairKinds: [],
};

type Relation = 'supports' | 'contradicts' | 'unrelated';
const assessment = (support: string, claimType: string, relations: Relation[]) => ({
  support,
  claimType,
  records: relations.map((relation, record) => ({ record, relation })),
});
const ALL_SUPPORT: Relation[] = ['supports', 'supports', 'supports', 'supports'];
const ONE_CONTRADICTS: Relation[] = ['unrelated', 'unrelated', 'contradicts', 'unrelated'];

/** A claim to decide: its atoms are checked against the records of its pointer, as `research.verify` does. */
interface Claim {
  readonly assessment: unknown;
  readonly atoms?: readonly Atom[];
  readonly pointer?: Pointer;
  readonly groupTable?: GroupTable | undefined;
}

function input({ assessment: answer, atoms = COUNT_40, pointer = COUNTS_AND_LOGS, ...rest }: Claim): DecideClaimInput {
  const records = pointedRecords(pointer, PAGES).map(({ record }) => record);
  return {
    assessment: answer,
    pointer,
    atomCheck: checkAtoms({ atoms, records }),
    pages: PAGES,
    groupTable: 'groupTable' in rest ? rest.groupTable : TABLE,
  };
}

type Expected = Pick<ClaimDecision, 'status' | 'reason' | 'claimType' | 'basis' | 'profile' | 'confidence'> & {
  /** The verdict of each atom, as the decision carries the atom check. */
  readonly verdicts: readonly string[];
};
const FOUND_BOTH = ['found', 'found'];
const invalid: Expected = { status: 'insufficient', reason: 'invalid_assessment', claimType: null, basis: [], profile: null, confidence: null, verdicts: FOUND_BOTH };
const quantitative = (fields: Pick<ClaimProfile, 'valueCheck' | 'independentRecords'>): ClaimProfile => ({
  claimType: 'quantitative',
  contradictions: false,
  ...fields,
});

describe('decideClaim: status, type, basis, profile and group', () => {
  it.each<[string, DecideClaimInput, Expected]>([
    // Form (DC-7): an off-form assessment never becomes supported.
    ['no assessment in form', input({ assessment: null }), invalid],
    ['a value outside its list', input({ assessment: assessment('probably', 'observation', ALL_SUPPORT) }), invalid],
    ['a relation missing for a given record', input({ assessment: assessment('yes', 'quantitative', ['supports', 'supports', 'supports']) }), invalid],
    [
      'a record number that was not in the input',
      input({ assessment: { ...assessment('yes', 'quantitative', ALL_SUPPORT), records: [0, 1, 2, 4].map((record) => ({ record, relation: 'supports' })) } }),
      invalid,
    ],
    ['support yes without a supporting record', input({ assessment: assessment('yes', 'quantitative', ['unrelated', 'unrelated', 'unrelated', 'unrelated']) }), invalid],
    // Type (DC-10): causal whatever the support answer.
    [
      'causal with support yes',
      input({ assessment: assessment('yes', 'causal', ALL_SUPPORT) }),
      { status: 'causal', reason: null, claimType: 'causal', basis: ['pCount', 'pLogs'], profile: null, confidence: null, verdicts: FOUND_BOTH },
    ],
    [
      'causal with support no',
      input({ assessment: assessment('no', 'causal', ONE_CONTRADICTS) }),
      { status: 'causal', reason: null, claimType: 'causal', basis: [], profile: null, confidence: null, verdicts: FOUND_BOTH },
    ],
    // Support (AC-12.1, UC-2): the answer decides, whatever the atom check found.
    [
      'UC-2: support no although every atom is found',
      input({ assessment: assessment('no', 'quantitative', ONE_CONTRADICTS) }),
      { status: 'refuted', reason: null, claimType: 'quantitative', basis: ['pLogs'], profile: null, confidence: null, verdicts: FOUND_BOTH },
    ],
    [
      'support insufficient',
      input({ assessment: assessment('insufficient', 'quantitative', ['unrelated', 'unrelated', 'unrelated', 'unrelated']) }),
      { status: 'insufficient', reason: 'no_support_data', claimType: 'quantitative', basis: [], profile: null, confidence: null, verdicts: FOUND_BOTH },
    ],
    // Support yes under each result of the atom check (KD-2, DC-9): supported, the result in the profile only.
    [
      'support yes, every atom found: matched',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT) }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: quantitative({ valueCheck: 'matched', independentRecords: 'two_or_more' }),
        confidence: 'high',
        verdicts: FOUND_BOTH,
      },
    ],
    [
      'support yes, a number missing from the pointed records: unmatched',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT), atoms: [{ kind: 'text', value: 'payments' }, { kind: 'number', value: '42' }] }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: quantitative({ valueCheck: 'unmatched', independentRecords: 'two_or_more' }),
        confidence: 'low',
        verdicts: ['found', 'missing'],
      },
    ],
    [
      'support yes, a time the pointed records contradict: unmatched',
      input({
        assessment: assessment('yes', 'quantitative', ALL_SUPPORT),
        atoms: [{ kind: 'text', value: 'payments' }, { kind: 'time', value: '2026-10-01T14:00:00Z/2026-10-01T15:00:00Z' }],
      }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: quantitative({ valueCheck: 'unmatched', independentRecords: 'two_or_more' }),
        confidence: 'low',
        verdicts: ['found', 'contradicted'],
      },
    ],
    [
      'support yes, no atoms: not_applicable',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT), atoms: [] }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: quantitative({ valueCheck: 'not_applicable', independentRecords: 'two_or_more' }),
        confidence: 'low',
        verdicts: [],
      },
    ],
    // The atom check runs over the pointer's records only.
    [
      'a count only an unpointed bucket holds is missing',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT), atoms: [{ kind: 'number', value: '7' }] }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: quantitative({ valueCheck: 'unmatched', independentRecords: 'two_or_more' }),
        confidence: 'low',
        verdicts: ['missing'],
      },
    ],
    [
      'the same count with the pointer naming that bucket is found',
      input({
        assessment: assessment('yes', 'quantitative', ALL_SUPPORT),
        atoms: [{ kind: 'number', value: '7' }],
        pointer: [{ pageId: 'pCount', records: [0, 1, 2] }, { pageId: 'pLogs', records: [0] }],
      }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: quantitative({ valueCheck: 'matched', independentRecords: 'two_or_more' }),
        confidence: 'high',
        verdicts: ['found'],
      },
    ],
    // UC-3: 412 against a group counting 380 in that hour — the number missing, the time found by the group start.
    [
      'UC-3: support no on the group counting 380',
      input({ assessment: assessment('no', 'quantitative', ['contradicts']), atoms: TIMEOUTS_412, pointer: [{ pageId: 'pTimeout380', records: [0] }] }),
      { status: 'refuted', reason: null, claimType: 'quantitative', basis: ['pTimeout380'], profile: null, confidence: null, verdicts: ['found', 'missing', 'found'] },
    ],
    [
      'UC-3: support yes on the group counting 380',
      input({ assessment: assessment('yes', 'quantitative', ['supports']), atoms: TIMEOUTS_412, pointer: [{ pageId: 'pTimeout380', records: [0] }] }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pTimeout380'],
        profile: quantitative({ valueCheck: 'unmatched', independentRecords: 'one' }),
        confidence: 'low',
        verdicts: ['found', 'missing', 'found'],
      },
    ],
    [
      'UC-3: support yes on the group counting 412',
      input({ assessment: assessment('yes', 'quantitative', ['supports']), atoms: TIMEOUTS_412, pointer: [{ pageId: 'pTimeout412', records: [0] }] }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pTimeout412'],
        profile: quantitative({ valueCheck: 'matched', independentRecords: 'one' }),
        confidence: 'low',
        verdicts: ['found', 'found', 'found'],
      },
    ],
    // Profile (KD-3): independence by traceId.
    [
      'two rows of one trace are one independent record',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 2] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'one', contradictions: false }), confidence: 'medium', verdicts: [] },
    ],
    [
      'rows of two traces are two independent records',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 1] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'two_or_more', contradictions: false }), confidence: 'high', verdicts: [] },
    ],
    [
      'a row without traceId counts on its own',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 3] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'two_or_more', contradictions: false }), confidence: 'high', verdicts: [] },
    ],
    // Group (DC-11, UC-E7): a profile the table lacks, and no table, get the lowest group.
    [
      'a contradicting record: a profile the table lacks',
      input({ assessment: assessment('yes', 'observation', ['supports', 'contradicts']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 1] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'one', contradictions: true }), confidence: 'low', verdicts: [] },
    ],
    [
      'no group table for the configuration',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 2] }], groupTable: undefined }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'one', contradictions: false }), confidence: 'low', verdicts: [] },
    ],
  ])('%s', (_, claim, expected) => {
    const { status, reason, claimType, basis, profile: decided, confidence, values } = decideClaim(claim);

    expect({ status, reason, claimType, basis, profile: decided, confidence, verdicts: values.atoms.map((atom) => atom.verdict) }).toEqual(expected);
  });
});
