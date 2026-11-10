import fc from 'fast-check';
import { gatherKeyFields, type GatherRequest } from './gather-key.js';

// DC-4 (FR-02), the engine's half of the dedup key: the fields of a `source.fetch` task that enter the runtime's
// `dedup_key` (input, input references, expected output) depend only on the tool, its arguments and the pinned
// snapshot. Defects caught: another field beside the request (here a `rationale`) reaching the task input or the
// expected output, so the same request with another note creates a second task; the expected output built from the
// arguments in their arrival order, so the same request with its keys reordered gets another key; the snapshot left
// out of the input references, so a request after a snapshot change is served from the old task.

/** The same JSON value with the keys of every object in reverse order. */
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reordered(item)]),
  );
}

const request = (args: Record<string, unknown>, rationale: string): GatherRequest & { readonly rationale: string } => ({
  rationale,
  sourceId: 'fixture',
  toolName: 'search_logs',
  args,
  completeness: 'all',
});

const argsArbitrary = fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 6 });

describe('gather key (DC-4)', () => {
  it('the same tool, arguments and snapshot give the same key whatever the rationale and the key order; another snapshot gives another key', () => {
    fc.assert(
      fc.property(
        argsArbitrary,
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (args, firstRationale, secondRationale, snapshot, otherSnapshot) => {
          const first = JSON.stringify(gatherKeyFields(request(args, firstRationale), snapshot));
          const second = JSON.stringify(
            gatherKeyFields(request(reordered(args) as Record<string, unknown>, secondRationale), snapshot),
          );

          expect(second).toBe(first);
          const afterSnapshotChange = JSON.stringify(gatherKeyFields(request(args, firstRationale), otherSnapshot));
          expect(afterSnapshotChange === first).toBe(snapshot === otherSnapshot);
        },
      ),
    );
  });
});
