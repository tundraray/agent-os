import { type AtomCheck, type AtomCheckInput, checkAtoms } from './check-atoms.js';

// DC-9, UC-3 (design-engine.md, «Сверка атомов», KD-9): each atom is compared with every value of the pointed records,
// at any depth, without reading their keys. Defects caught: a match by field name, an interval that includes its end,
// a number found as the sum of several groups, `contradicted` on a text or a number, a stored atom of a former kind not
// read as its primitive, a number atom read in a writing other than a decimal literal — and the check on the real
// shape of a count group `{ start, key, count }` (the old test held an invented one).

const TRACE = 'a'.repeat(32);
const record = (fields: Record<string, unknown>) => fields;
/** A log line of the fixture source. */
const logLine = (ts: string) =>
  record({ ts, service: 'payments', level: 'error', event: 'refund', traceId: TRACE, spanSeq: 1, status: 'timeout', durationMs: 5000, message: 'provider did not answer' });
/** A count group of `aggregate_logs`. */
const group = (start: string, key: string, count: number) => record({ start, key, count });

type Expected = Pick<AtomCheck, 'valueCheck'> & { atoms: { verdict: string; records: number[] }[] };
const one = (verdict: string, records: number[], valueCheck: AtomCheck['valueCheck']): Expected => ({ atoms: [{ verdict, records }], valueCheck });

describe('checkAtoms: atoms against every value of the pointed records', () => {
  it.each<[string, AtomCheckInput, Expected]>([
    ['text equal to a value is found', { atoms: [{ kind: 'text', value: 'payments' }], records: [logLine('2026-10-01T12:00:00.000Z')] }, one('found', [0], 'matched')],
    ['text equal to no value is missing', { atoms: [{ kind: 'text', value: 'checkout' }], records: [logLine('2026-10-01T12:00:00.000Z')] }, one('missing', [], 'unmatched')],
    [
      'text in an element of a nested list is found',
      { atoms: [{ kind: 'text', value: 'retry' }], records: [record({ ts: '2026-10-01T12:00:00.000Z' }), record({ meta: { tags: ['first', 'retry'] } })] },
      one('found', [1], 'matched'),
    ],
    [
      'text equal to a field name is missing: keys are not read',
      { atoms: [{ kind: 'text', value: 'service' }], records: [logLine('2026-10-01T12:00:00.000Z')] },
      one('missing', [], 'unmatched'),
    ],
    [
      'number equal to a numeric value is found in every record that holds it',
      { atoms: [{ kind: 'number', value: '412' }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412), group('2026-10-01T20:00:00.000Z', 'timeout', 7), group('2026-10-01T21:00:00.000Z', 'error', 412)] },
      one('found', [0, 2], 'matched'),
    ],
    [
      'number equal to no value is missing, never contradicted',
      { atoms: [{ kind: 'number', value: '413' }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] },
      one('missing', [], 'unmatched'),
    ],
    [
      'number atom that is not a number is missing',
      { atoms: [{ kind: 'number', value: 'many' }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] },
      one('missing', [], 'unmatched'),
    ],
    ...['0x19C', '4.12e2', '+412', ' 412 '].map((value): [string, AtomCheckInput, Expected] => [
      `number atom ${JSON.stringify(value)} that is not a decimal literal is missing`,
      { atoms: [{ kind: 'number', value }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] },
      one('missing', [], 'unmatched'),
    ]),
    ...[
      ['-3', -3],
      ['0.5', 0.5],
      ['0', 0],
    ].map(([value, held]): [string, AtomCheckInput, Expected] => [
      `number atom ${JSON.stringify(value)} is found in a record holding ${String(held)}`,
      { atoms: [{ kind: 'number', value: String(value) }], records: [record({ delta: held })] },
      one('found', [0], 'matched'),
    ]),
    [
      'empty number atom is missing, never read as 0',
      { atoms: [{ kind: 'number', value: '' }], records: [record({ delta: 0 })] },
      one('missing', [], 'unmatched'),
    ],
    [
      'number equal to the sum of two groups only is missing',
      { atoms: [{ kind: 'number', value: '42' }], records: [group('2026-10-01T12:00:00.000Z', 'timeout', 40), group('2026-10-01T13:00:00.000Z', 'timeout', 2)] },
      one('missing', [], 'unmatched'),
    ],
    [
      'number written as text in a record is missing: only numeric values compare',
      { atoms: [{ kind: 'number', value: '412' }], records: [record({ key: '412' })] },
      one('missing', [], 'unmatched'),
    ],
    [
      'time interval holding the start of a count group is found',
      {
        atoms: [{ kind: 'time', value: '2026-10-01T19:00:00Z/2026-10-01T20:00:00Z' }],
        records: [group('2026-10-01T18:00:00.000Z', 'timeout', 3), group('2026-10-01T19:00:00.000Z', 'timeout', 412)],
      },
      one('found', [1], 'matched'),
    ],
    [
      'time interval whose end is the only date field is contradicted: the end is excluded',
      { atoms: [{ kind: 'time', value: '2026-10-01T19:00:00Z/2026-10-01T20:00:00Z' }], records: [group('2026-10-01T20:00:00.000Z', 'timeout', 412)] },
      one('contradicted', [], 'unmatched'),
    ],
    [
      'time moment equal to a date field with another offset is found',
      { atoms: [{ kind: 'time', value: '2026-10-01T15:05:00+03:00' }], records: [logLine('2026-10-01T12:00:00.000Z'), logLine('2026-10-01T12:05:00.000Z')] },
      one('found', [1], 'matched'),
    ],
    [
      'time over records without a date field is missing',
      { atoms: [{ kind: 'time', value: '2026-10-01T19:00:00Z/2026-10-01T20:00:00Z' }], records: [record({ key: 'timeout', count: 412, at: '2026-10-01T19:30:00' })] },
      one('missing', [], 'unmatched'),
    ],
    [
      'time atom that is not ISO 8601 is missing',
      { atoms: [{ kind: 'time', value: 'from 19:00 to 20:00' }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] },
      one('missing', [], 'unmatched'),
    ],
    [
      'stored interval atom is read as time',
      { atoms: [{ kind: 'interval', value: '2026-10-01T12:00:00Z/2026-10-01T12:15:00Z' }], records: [logLine('2026-10-01T12:05:00.000Z')] },
      one('found', [0], 'matched'),
    ],
    [
      'stored service atom is read as text in any field',
      { atoms: [{ kind: 'service', value: 'timeout' }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] },
      one('found', [0], 'matched'),
    ],
    [
      'atom of a kind outside the known ones is missing',
      { atoms: [{ kind: 'duration', value: 'timeout' }], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] },
      one('missing', [], 'unmatched'),
    ],
    ['claim without atoms is not applicable', { atoms: [], records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)] }, { atoms: [], valueCheck: 'not_applicable' }],
    [
      'design example: timeout, 412 and the hour found, payment-api missing — unmatched',
      {
        atoms: [
          { kind: 'text', value: 'timeout' },
          { kind: 'number', value: '412' },
          { kind: 'time', value: '2026-10-01T19:00:00Z/2026-10-01T20:00:00Z' },
          { kind: 'text', value: 'payment-api' },
        ],
        records: [group('2026-10-01T19:00:00.000Z', 'timeout', 412)],
      },
      {
        atoms: [
          { verdict: 'found', records: [0] },
          { verdict: 'found', records: [0] },
          { verdict: 'found', records: [0] },
          { verdict: 'missing', records: [] },
        ],
        valueCheck: 'unmatched',
      },
    ],
  ])('%s', (_, input, expected) => {
    const check = checkAtoms(input);

    expect({ atoms: check.atoms.map(({ verdict, records }) => ({ verdict, records })), valueCheck: check.valueCheck }).toEqual(expected);
    expect(check.atoms.map(({ kind, value }) => ({ kind, value }))).toEqual(input.atoms);
  });
});
