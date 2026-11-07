import { type ClaimToVerify, type ClaimVerdict, verifyClaim } from './claim-verifier.js';

// DC-9 (FR-13, AC-13.1): the value check compares each atom by its kind with the records of the claim's pointer — the
// only records `decideClaim` gives it (which records those are is proven in decide-claim.spec.ts). Defect caught: an
// absent atom refutes instead of being insufficient, a contradicting record does not refute, or atoms the pointed records
// do not hold pass.

const TRACE = 'a'.repeat(32);
/** A record of the pointer: `evidenceId` is the id of its page. */
const record = (evidenceId: string, fields: Record<string, unknown>) => ({ evidenceId, record: fields });
const payments = (ts: string) => ({ ts, service: 'payments', event: 'refund', traceId: TRACE, status: 'error' });

describe('verifyClaim: atoms against the records of the pointer', () => {
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
      'pointed records of another service and no count: both atoms missing, not refuted',
      {
        atoms: [{ kind: 'service', value: 'payments' }, { kind: 'number', value: '42' }],
        records: [record('e5', { ts: '2026-10-01T12:00:00Z', service: 'checkout', event: 'refund' })],
      },
      { status: 'insufficient', basis: [], missing: ['service', 'number'] },
    ],
  ])('%s', (_, claim, expected) => {
    const verdict = verifyClaim(claim);

    expect({ status: verdict.status, basis: verdict.basis, missing: verdict.missingAtoms.map((atom) => atom.kind) }).toEqual(expected);
  });
});
