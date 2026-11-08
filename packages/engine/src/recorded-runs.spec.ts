import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { checkAtoms } from './verify/check-atoms.js';
import { ClaimAssessmentSchema } from './verify/claim-assessment.js';
import { decideClaim } from './verify/decide-claim.js';
import { PointerSchema, pointedRecords } from './verify/pointer.js';

// UC-R1 (DC-19, DC-9; design-engine.md, Regression on Recorded Runs). Defect caught: the atom check drops a claim the
// verifier confirmed as `insufficient` for a missing value, because a time atom over count groups `{ start, key, count }` (no `ts`) is
// never found — a mismatch between the records of the test doubles and of the real source that no double shows.
// The fixture holds the six such claims of the first four investigations on real models (its `source` says how).

const CountGroupSchema = z.strictObject({ count: z.number(), key: z.string(), start: z.string() });

const RecordedClaimSchema = z
  .strictObject({
    claimId: z.string(),
    investigationId: z.string(),
    checkStatus: z.literal('insufficient'),
    text: z.string(),
    atoms: z.array(z.strictObject({ kind: z.string(), value: z.string() })),
    pointer: PointerSchema,
    assessment: ClaimAssessmentSchema.extend({ support: z.literal('yes') }),
    pages: z.record(z.string(), z.array(CountGroupSchema)),
  })
  .superRefine((claim, context) => {
    const outside = claim.pointer.some(({ pageId, records }) => records.some((number) => !(number < (claim.pages[pageId]?.length ?? 0))));
    if (outside) context.addIssue({ code: 'custom', message: `pointer of ${claim.claimId} names a record its pages lack` });
    if (claim.atoms.filter((atom) => atom.kind === 'interval').length !== 1) {
      context.addIssue({ code: 'custom', message: `${claim.claimId} has not exactly one time atom` });
    }
  });
const RecordedRunsSchema = z.object({ source: z.object({ claimCount: z.literal(6) }), claims: z.array(RecordedClaimSchema).length(6) });

const fixture = RecordedRunsSchema.parse(
  JSON.parse(readFileSync(new URL('../test/fixtures/recorded-runs-20261108.json', import.meta.url), 'utf8')),
);

/**
 * Worked out by hand from the fixture: each claim's time atom (stored as `interval`) against the `start` of the count
 * groups its pointer names, by `[from, to)`. In every claim the first pointed group starts at `from`, so each is found;
 * in the last four the last pointed group starts at or after `to`, so «some group inside», not «every group inside».
 */
const EXPECTED = [
  { claimId: 'ae57e066-aa75-440b-9069-8a5f37c549df', timeAtom: '2026-09-14T22:00:00.000Z/2026-09-14T22:15:00.000Z', timeVerdict: 'found' },
  { claimId: 'e054b5ce-01f7-4a34-a671-57543723822d', timeAtom: '2026-09-15T00:00:00.000Z/2026-09-15T01:00:00.000Z', timeVerdict: 'found' },
  { claimId: '5e4a2163-0c4f-4920-9c13-b858bea69b8a', timeAtom: '2026-09-14T23:00:00.000Z/2026-09-15T00:00:00.000Z', timeVerdict: 'found' },
  { claimId: '8828205d-a190-436c-b103-33657d5000bc', timeAtom: '2026-09-14T13:00:00.000Z/2026-09-14T23:00:00.000Z', timeVerdict: 'found' },
  { claimId: 'b6d58559-c7d8-48da-8074-bf0ca25c9c2a', timeAtom: '2026-09-14T00:00:00.000Z/2026-09-14T10:00:00.000Z', timeVerdict: 'found' },
  { claimId: '378b7b8b-6160-4366-9e6c-8b59d6c6df0e', timeAtom: '2026-09-14T11:00:00.000Z/2026-09-14T23:00:00.000Z', timeVerdict: 'found' },
].map((row) => ({ ...row, status: 'supported', reason: null }));

describe('recorded runs of 2026-11-08', () => {
  // Keeps the red of UC-R1 below a red of the rule, not of the fixture: the recorded claims are the expected ones.
  it('fixture holds the claims UC-R1 expects', () => {
    expect(fixture.claims.map((claim) => claim.claimId)).toEqual(EXPECTED.map((row) => row.claimId));
  });

  it('UC-R1: every claim the verifier confirmed over count groups is supported, its time atom judged by the group start', () => {
    const results = fixture.claims.map((claim) => {
      const pages = new Map(Object.entries(claim.pages));
      const records = pointedRecords(claim.pointer, pages).map(({ record }) => record);
      const decision = decideClaim({
        assessment: claim.assessment,
        pointer: claim.pointer,
        atomCheck: checkAtoms({ atoms: claim.atoms, records }),
        pages,
        groupTable: undefined,
      });
      const timeAtom = claim.atoms.find((atom) => atom.kind === 'interval')?.value;
      return {
        claimId: claim.claimId,
        timeAtom,
        timeVerdict: decision.values.atoms.find((atom) => atom.value === timeAtom)?.verdict,
        status: decision.status,
        reason: decision.reason,
      };
    });

    expect(results).toEqual(EXPECTED);
  });
});
