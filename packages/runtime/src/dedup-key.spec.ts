import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDedupKey, type DedupKeySource } from './dedup-key.js';

const base: DedupKeySource = {
  workflowType: 'fetch',
  workflowVersion: 1,
  input: { query: 'q', filters: { from: '2026', to: '2027' }, ids: [1, 2] },
  expectedOutput: { description: 'all matches', completeness: 'all' },
  inputRefs: [
    { kind: 'page', ref: 'b', snapshot: 's1' },
    { kind: 'doc', ref: 'z', snapshot: 's1' },
    { kind: 'page', ref: 'a', snapshot: 's1' },
  ],
};

describe('computeDedupKey — dedup key canonicalization (AC-06.3, AC-06.5, AC-06.6)', () => {
  it('is v1: plus the sha256 of the canonical JSON (sorted keys, inputRefs by kind and ref)', () => {
    const canonical =
      '{"expectedOutput":{"completeness":"all","description":"all matches"},' +
      '"input":{"filters":{"from":"2026","to":"2027"},"ids":[1,2],"query":"q"},' +
      '"inputRefs":[{"kind":"doc","ref":"z","snapshot":"s1"},{"kind":"page","ref":"a","snapshot":"s1"},{"kind":"page","ref":"b","snapshot":"s1"}],' +
      '"workflowType":"fetch","workflowVersion":1}';
    const expected = `v1:${createHash('sha256').update(canonical).digest('hex')}`;

    expect(computeDedupKey(base)).toBe(expected);
  });

  it.each<{ name: string; other: DedupKeySource }>([
    {
      name: 'another handler version (AC-06.5) → another key',
      other: { ...base, workflowVersion: 2 },
    },
    {
      name: 'completeness sample instead of all (AC-06.6) → another key',
      other: {
        ...base,
        expectedOutput: { ...base.expectedOutput, completeness: 'sample' },
      },
    },
    {
      name: 'another snapshot of an input ref → another key (the key half of AC-06.4; the admission is INT-1 B6)',
      other: {
        ...base,
        inputRefs: [
          { kind: 'page', ref: 'b', snapshot: 's2' },
          ...base.inputRefs.slice(1),
        ],
      },
    },
    {
      name: 'array elements of input in another order → another key',
      other: { ...base, input: { ...base.input, ids: [2, 1] } },
    },
  ])('$name', ({ other }) => {
    expect(computeDedupKey(other)).not.toBe(computeDedupKey(base));
  });

  it('does not depend on the order of object keys at any depth, nor on the order of inputRefs (property)', () => {
    const inputRef = fc.record({
      kind: fc.string({ minLength: 1, maxLength: 5 }),
      ref: fc.string({ minLength: 1, maxLength: 5 }),
      snapshot: fc.string({ minLength: 1, maxLength: 5 }),
    });
    // `input` is a JSON object; its values are JSON of depth ≤ 2, so the whole is depth ≤ 3.
    const input = fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 }));

    fc.assert(
      fc.property(
        input,
        fc.array(inputRef, { maxLength: 4 }),
        fc.integer(),
        (generatedInput, inputRefs, seed) => {
          const source: DedupKeySource = {
            ...base,
            input: generatedInput as DedupKeySource['input'],
            inputRefs,
          };
          const random = seededRandom(seed);
          const shuffled: DedupKeySource = {
            ...source,
            input: shuffleKeysDeep(
              generatedInput,
              random,
            ) as DedupKeySource['input'],
            inputRefs: shuffle(inputRefs, random),
          };

          expect(computeDedupKey(shuffled)).toBe(computeDedupKey(source));
        },
      ),
    );
  });
});

/** mulberry32: a deterministic generator, so a failing case replays from its seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Rebuilds every object with its keys in a shuffled order; arrays keep their order. */
function shuffleKeysDeep(value: unknown, random: () => number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => shuffleKeysDeep(item, random));
  }
  if (value === null || typeof value !== 'object') return value;
  const entries = shuffle(Object.entries(value), random);
  // `Object.fromEntries` defines own properties, so a generated `__proto__` key stays data.
  return Object.fromEntries(
    entries.map(([key, item]) => [key, shuffleKeysDeep(item, random)]),
  );
}
