import fc from 'fast-check';
import { type Atom, verifyClaim } from './claim-verifier.js';
import { decideClaim } from './decide-claim.js';
import { type Pointer, checkPointer, pointedRecords } from './pointer.js';

// Invariant 1 (design-engine.md, State Transitions and Invariants; DC-7, DC-9, DC-10): a claim is `supported` only by a
// well-formed `yes` of a non-causal type whose value check over the pointer's records found every atom. Defect caught:
// a code path that sets `supported` past one of these conditions, which the table rows of decide-claim.spec.ts do not
// enumerate. The oracle reads the raw assessment and runs the value check itself; it never reads `decideClaim`'s output
// beyond the status.

const TRACES = ['a'.repeat(32), 'b'.repeat(32)];
const SERVICES = ['payments', 'auth'];
const EVENTS = ['refund', 'login'];
const TIMES = ['2026-10-01T12:05:00Z', '2026-10-01T12:30:00Z', '2026-10-01T14:00:00Z'];
const INTERVALS = [
  '2026-10-01T12:00:00Z/2026-10-01T15:00:00Z',
  '2026-10-01T12:00:00Z/2026-10-01T13:00:00Z',
  '2026-10-01T12:20:00Z/2026-10-01T12:40:00Z',
  'not-an-interval',
];
const SUPPORT_VALUES = ['yes', 'no', 'insufficient'];
const TYPE_VALUES = ['observation', 'quantitative', 'causal'];
const RELATIONS = ['supports', 'contradicts', 'unrelated'];
const ESTABLISHED_TYPES = new Set(['observation', 'quantitative']);

/** Log rows with and without `traceId`, and count buckets `{ start, key, count }`, over small domains so values repeat. */
const logRecord = fc.record(
  {
    ts: fc.constantFrom(...TIMES),
    service: fc.constantFrom(...SERVICES),
    event: fc.constantFrom(...EVENTS),
    traceId: fc.constantFrom(...TRACES),
  },
  { requiredKeys: ['ts', 'service', 'event'] },
);
const countBucket = fc.record({
  start: fc.constant('2026-10-01T12:00:00.000Z'),
  key: fc.constantFrom(...SERVICES, 'other'),
  count: fc.integer({ min: 0, max: 5 }),
});

/** Pages `p0…`, and a pointer that passes `checkPointer`: some pages, some of their records, in any order. */
const recordSet = fc
  .array(fc.array(fc.oneof(logRecord, countBucket), { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 3 })
  .chain((pageList) => {
    const pages = new Map<string, readonly unknown[]>(pageList.map((records, index) => [`p${index}`, records]));
    const pageEntry = (pageId: string) =>
      fc
        .shuffledSubarray([...(pages.get(pageId) ?? []).keys()], { minLength: 1 })
        .map((records) => ({ pageId, records }));
    const pointer: fc.Arbitrary<Pointer> = fc
      .shuffledSubarray([...pages.keys()], { minLength: 1 })
      .chain((pageIds) => fc.tuple(...pageIds.map(pageEntry)));
    return pointer.map((chosen) => ({ pages, pointer: chosen }));
  });

/** Atoms of the five kinds, with values the records hold and values they do not. */
const atom: fc.Arbitrary<Atom> = fc.oneof(
  fc.record({ kind: fc.constant('traceId'), value: fc.constantFrom(...TRACES, 'c'.repeat(32)) }),
  fc.record({ kind: fc.constant('service'), value: fc.constantFrom(...SERVICES, 'billing') }),
  fc.record({ kind: fc.constant('event'), value: fc.constantFrom(...EVENTS, 'logout') }),
  fc.record({ kind: fc.constant('interval'), value: fc.constantFrom(...INTERVALS) }),
  fc.record({ kind: fc.constant('number'), value: fc.oneof(fc.integer({ min: 0, max: 15 }).map(String), fc.constant('many')) }),
);

/** A value from the list (more often) or outside it. */
const listedOrNot = (values: readonly string[], outside: string) =>
  fc.oneof({ arbitrary: fc.constantFrom(...values), weight: 5 }, { arbitrary: fc.constant(outside), weight: 1 });

type Breakage = 'none' | 'drop' | 'repeat' | 'extra' | 'fraction' | 'extraKey';
const breakage = fc.oneof(
  { arbitrary: fc.constant<Breakage>('none'), weight: 6 },
  fc.constantFrom<Breakage>('drop', 'repeat', 'extra', 'fraction', 'extraKey'),
);

/** Relations for the given record numbers 0…given-1, then possibly a skipped, repeated or foreign number. */
function relationItems(relations: readonly string[], broken: Breakage): unknown[] {
  const items: Record<string, unknown>[] = relations.map((relation, record) => ({ record, relation }));
  const first = items[0] ?? { record: 0, relation: 'supports' };
  if (broken === 'drop') return items.slice(1);
  if (broken === 'repeat') return [...items, { ...first }];
  if (broken === 'extra') return [...items, { record: relations.length, relation: 'supports' }];
  if (broken === 'fraction') return [...items.slice(1), { record: 0.5, relation: first.relation }];
  if (broken === 'extraKey') return [{ ...first, note: 'x' }, ...items.slice(1)];
  return items;
}

const assessmentFor = (given: number): fc.Arbitrary<unknown> =>
  fc.oneof(
    { arbitrary: fc.constant(null), weight: 1 },
    {
      arbitrary: fc
        .record({
          support: listedOrNot(SUPPORT_VALUES, 'probably'),
          claimType: listedOrNot(TYPE_VALUES, 'opinion'),
          relations: fc.array(listedOrNot(RELATIONS, 'related'), { minLength: given, maxLength: given }),
          broken: breakage,
        })
        .map(({ support, claimType, relations, broken }) => ({ support, claimType, records: relationItems(relations, broken) })),
      weight: 12,
    },
  );

const claimCase = recordSet.chain(({ pages, pointer }) => {
  const given = pointedRecords(pointer, pages).length;
  return fc.record({
    pages: fc.constant(pages),
    pointer: fc.constant(pointer),
    atoms: fc.array(atom, { maxLength: 3 }),
    assessment: assessmentFor(given),
  });
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** The oracle's form rule, read from the raw assessment: a closed `yes` of an established type with a listed relation
 * for every given record number exactly once, no other number, and at least one `supports`. */
function isWellFormedYes(raw: unknown, given: number): boolean {
  if (!isObject(raw) || !hasKeys(raw, ['support', 'claimType', 'records'])) return false;
  if (raw.support !== 'yes' || typeof raw.claimType !== 'string' || !ESTABLISHED_TYPES.has(raw.claimType)) return false;
  if (!Array.isArray(raw.records)) return false;
  const items: unknown[] = raw.records;
  const closed = items.every(
    (item) => isObject(item) && hasKeys(item, ['record', 'relation']) && typeof item.relation === 'string' && RELATIONS.includes(item.relation),
  );
  if (!closed) return false;
  const numbers = items.map((item) => (item as Record<string, unknown>).record);
  const expected = Array.from({ length: given }, (_, index) => index);
  const sorted = [...numbers].sort((left, right) => Number(left) - Number(right));
  const exactlyOnce = sorted.length === given && sorted.every((number, index) => number === expected[index]);
  return exactlyOnce && items.some((item) => (item as Record<string, unknown>).relation === 'supports');
}

describe('decideClaim: Invariant 1', () => {
  it('FOR ALL assessments and record sets, supported implies a well-formed yes of a non-causal type with every value found', () => {
    let supported = 0;
    let supportedWithAtoms = 0;
    fc.assert(
      fc.property(claimCase, ({ pages, pointer, atoms, assessment }) => {
        expect(checkPointer(pointer, new Map([...pages].map(([pageId, records]) => [pageId, records.length]))).valid).toBe(true);
        const records = pointedRecords(pointer, pages);

        const decision = decideClaim({ assessment, pointer, atoms, pages, groupTable: undefined });

        if (decision.status !== 'supported') return;
        supported += 1;
        expect(isWellFormedYes(assessment, records.length)).toBe(true);
        if (atoms.length === 0) return;
        supportedWithAtoms += 1;
        const values = verifyClaim({ atoms, records: records.map(({ pageId, record }) => ({ evidenceId: pageId, record })) });
        expect(values.atoms.map((item) => item.verdict)).toEqual(atoms.map(() => 'found'));
      }),
      { numRuns: 2000 },
    );
    // The property is not vacuous: supported decisions occurred, with and without atoms to check.
    expect(supported).toBeGreaterThan(supportedWithAtoms);
    expect(supportedWithAtoms).toBeGreaterThan(0);
  });
});
