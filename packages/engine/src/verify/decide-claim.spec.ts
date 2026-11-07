import type { GroupTable } from '../calibration/group-table.js';
import type { ClaimProfile } from './claim-assessment.js';
import type { Atom } from './claim-verifier.js';
import { type ClaimDecision, type DecideClaimInput, decideClaim } from './decide-claim.js';
import type { Pointer } from './pointer.js';

// DC-7, DC-9, DC-10, DC-11, UC-E7 (AC-12.1, AC-12.2, AC-13.1, AC-14.1, AC-15.1): the model assesses, the algorithm
// decides. Defects caught: `supported` with an off-form assessment; a causal claim established; the value check run
// over a page record outside the pointer; two rows of one trace counted as two independent records; a group that is
// not the table's.

const TRACE_A = 'a'.repeat(32);
const TRACE_B = 'b'.repeat(32);
const bucket = (count: number) => ({ start: '2026-10-01T12:00:00.000Z', key: 'payments', count });
const log = (ts: string, traceId?: string) => ({ ts, service: 'payments', event: 'refund', ...(traceId === undefined ? {} : { traceId }) });

/** `pCount` record 2 is outside every pointer below but one: a number check over it would contradict 42. */
const PAGES = new Map<string, readonly unknown[]>([
  ['pCount', [bucket(40), bucket(2), bucket(7)]],
  ['pLogs', [log('2026-10-01T12:05:00Z', TRACE_A), log('2026-10-01T12:06:00Z', TRACE_B), log('2026-10-01T12:07:00Z', TRACE_A), log('2026-10-01T12:08:00Z')]],
]);

/** Input records 0, 1 — the two counted buckets; 2, 3 — log rows of traces A and B. */
const COUNTS_AND_LOGS: Pointer = [
  { pageId: 'pCount', records: [0, 1] },
  { pageId: 'pLogs', records: [0, 1] },
];
const COUNT_42: Atom[] = [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }];

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

const input = (fields: Partial<DecideClaimInput> & Pick<DecideClaimInput, 'assessment'>): DecideClaimInput => ({
  pointer: COUNTS_AND_LOGS,
  atoms: COUNT_42,
  pages: PAGES,
  groupTable: TABLE,
  ...fields,
});

type Expected = Pick<ClaimDecision, 'status' | 'reason' | 'claimType' | 'basis' | 'profile' | 'confidence'>;
const invalid: Expected = { status: 'insufficient', reason: 'invalid_assessment', claimType: null, basis: [], profile: null, confidence: null };

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
      { status: 'causal', reason: null, claimType: 'causal', basis: ['pCount', 'pLogs'], profile: null, confidence: null },
    ],
    [
      'causal with support no',
      input({ assessment: assessment('no', 'causal', ONE_CONTRADICTS) }),
      { status: 'causal', reason: null, claimType: 'causal', basis: [], profile: null, confidence: null },
    ],
    // Support (AC-12.1).
    [
      'support no, though the values match',
      input({ assessment: assessment('no', 'quantitative', ONE_CONTRADICTS) }),
      { status: 'refuted', reason: null, claimType: 'quantitative', basis: ['pLogs'], profile: null, confidence: null },
    ],
    [
      'support insufficient',
      input({ assessment: assessment('insufficient', 'quantitative', ['unrelated', 'unrelated', 'unrelated', 'unrelated']) }),
      { status: 'insufficient', reason: 'no_support_data', claimType: 'quantitative', basis: [], profile: null, confidence: null },
    ],
    // Value check (DC-9) on the pointer's records only.
    [
      'a number the pointed buckets contradict',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT), atoms: [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '41' }] }),
      { status: 'refuted', reason: null, claimType: 'quantitative', basis: ['pCount'], profile: null, confidence: null },
    ],
    [
      'an atom absent from the pointed records',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT), atoms: [{ kind: 'event', value: 'chargeback' }] }),
      { status: 'insufficient', reason: 'values_missing', claimType: 'quantitative', basis: [], profile: null, confidence: null },
    ],
    [
      'values matched on the pointed records (the unpointed bucket would contradict)',
      input({ assessment: assessment('yes', 'quantitative', ALL_SUPPORT) }),
      {
        status: 'supported',
        reason: null,
        claimType: 'quantitative',
        basis: ['pCount', 'pLogs'],
        profile: { claimType: 'quantitative', valueCheck: 'matched', independentRecords: 'two_or_more', contradictions: false },
        confidence: 'high',
      },
    ],
    [
      'the same claim pointing at the third bucket too',
      input({
        assessment: assessment('yes', 'quantitative', ['supports', 'supports', 'supports', 'supports']),
        pointer: [{ pageId: 'pCount', records: [0, 1, 2] }, { pageId: 'pLogs', records: [0] }],
      }),
      { status: 'refuted', reason: null, claimType: 'quantitative', basis: ['pCount'], profile: null, confidence: null },
    ],
    // Profile (KD-3): no atoms — the value check does not apply; independence by traceId.
    [
      'two rows of one trace are one independent record',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 2] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'one', contradictions: false }), confidence: 'medium' },
    ],
    [
      'rows of two traces are two independent records',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 1] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'two_or_more', contradictions: false }), confidence: 'high' },
    ],
    [
      'a row without traceId counts on its own',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 3] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'two_or_more', contradictions: false }), confidence: 'high' },
    ],
    // Group (DC-11, UC-E7): a profile the table lacks, and no table, get the lowest group.
    [
      'a contradicting record: a profile the table lacks',
      input({ assessment: assessment('yes', 'observation', ['supports', 'contradicts']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 1] }] }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'one', contradictions: true }), confidence: 'low' },
    ],
    [
      'no group table for the configuration',
      input({ assessment: assessment('yes', 'observation', ['supports', 'supports']), atoms: [], pointer: [{ pageId: 'pLogs', records: [0, 2] }], groupTable: undefined }),
      { status: 'supported', reason: null, claimType: 'observation', basis: ['pLogs'], profile: profile({ independentRecords: 'one', contradictions: false }), confidence: 'low' },
    ],
  ])('%s', (_, claim, expected) => {
    const { status, reason, claimType, basis, profile: decided, confidence } = decideClaim(claim);

    expect({ status, reason, claimType, basis, profile: decided, confidence }).toEqual(expected);
  });
});
