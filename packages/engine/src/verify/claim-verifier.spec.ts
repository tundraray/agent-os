import { type ClaimToVerify, type ClaimVerdict, verifyClaim } from './claim-verifier.js';

// AC-08.1, AC-08.2, DC-10 (UC-6, the comparison half): the status of a claim is decided by code against the records the
// verification round fetched. Defect caught: the worker's summary (or a failed collection) counts as a source record, an
// absent atom refutes instead of being insufficient, or a contradicting record does not refute.

const TRACE = 'a'.repeat(32);
const record = (evidenceId: string, fields: Record<string, unknown>) => ({ evidenceId, record: fields });
const payments = (ts: string) => ({ ts, service: 'payments', event: 'refund', traceId: TRACE, status: 'error' });

describe('verifyClaim: atoms against fetched source records', () => {
  it.each<[string, ClaimToVerify, Pick<ClaimVerdict, 'status' | 'basis'> & { missing: string[] }]>([
    [
      'a traceId absent from the records is missing: insufficient, not refuted',
      {
        atoms: [{ kind: 'traceId', value: 'b'.repeat(32) }, { kind: 'service', value: 'payments' }],
        records: [record('e1', payments('2026-10-01T12:00:00Z'))],
      },
      { status: 'insufficient', basis: ['e1'], missing: ['traceId'] },
    ],
    [
      'a number equal to the aggregate count of its service: supported',
      {
        atoms: [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }],
        records: [
          record('e2', { start: '2026-10-01T12:00:00.000Z', key: 'payments', count: 40 }),
          record('e2', { start: '2026-10-01T13:00:00.000Z', key: 'payments', count: 2 }),
          record('e2', { start: '2026-10-01T12:00:00.000Z', key: 'checkout', count: 7 }),
        ],
      },
      { status: 'supported', basis: ['e2'], missing: [] },
    ],
    [
      'an interval a record of its trace lies outside of: refuted by that record',
      {
        atoms: [{ kind: 'traceId', value: TRACE }, { kind: 'interval', value: '2026-10-01T12:00:00Z/2026-10-01T12:15:00Z' }],
        records: [record('e3', payments('2026-10-01T12:05:00Z')), record('e4', payments('2026-10-01T12:40:00Z'))],
      },
      { status: 'refuted', basis: ['e4'], missing: [] },
    ],
    [
      'a claim resting on the worker summary only (no record fetched, a failed collection) is not supported',
      { atoms: [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }], records: [] },
      { status: 'insufficient', basis: [], missing: ['service', 'number'] },
    ],
  ])('%s', (_, claim, expected) => {
    const verdict = verifyClaim(claim);

    expect({ status: verdict.status, basis: verdict.basis, missing: verdict.missingAtoms.map((atom) => atom.kind) }).toEqual(expected);
  });
});
