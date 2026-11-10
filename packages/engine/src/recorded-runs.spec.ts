import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FormBindings } from './agents/result-forms.js';
import { CLAIM_ASSESSMENT_FORM, type ClaimAssessmentPrologueInput } from './research-flow/forms/claim-assessment.js';
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

  // UC-R1, AC-15.1. Defect caught: the form's prologue and closure part from the recorded statuses on the recorded data.
  it('UC-R1: the six claims pass the prologue and the closure of claim_assessment with the recorded statuses', () => {
    const bindings: FormBindings = { groupTables: { kind: 'definition_pair_table', value: [] } };
    const results = fixture.claims.map((claim) => {
      const prologueInput: ClaimAssessmentPrologueInput = {
        kind: 'claim',
        claimId: claim.claimId,
        text: claim.text,
        atoms: claim.atoms,
        pages: claim.pointer.map(({ pageId, records }) => ({
          pageId,
          source: 'recorded',
          tool: 'aggregate_logs',
          args: {},
          snapshot: 'recorded',
          complete: true,
          records: records.map((number) => claim.pages[pageId]![number]),
        })),
        agentFingerprint: '000000000000',
        definitionMemoryFingerprint: '111111111111',
      };
      const built = CLAIM_ASSESSMENT_FORM.prologue!.build(prologueInput, bindings);
      const decided = CLAIM_ASSESSMENT_FORM.closure!.evaluate({ result: claim.assessment, prologueInput, collected: null }, bindings);
      const timeAtom = claim.atoms.find((atom) => atom.kind === 'interval')?.value;
      const accepted = z
        .object({
          kind: z.literal('accept'),
          result: z.object({ claimId: z.string(), status: z.string() }),
          revision: z.object({ atoms: z.array(z.object({ value: z.string(), verdict: z.string() })) }),
        })
        .parse(decided);
      return {
        started: built.kind,
        claimId: accepted.result.claimId,
        timeAtom,
        timeVerdict: accepted.revision.atoms.find((atom) => atom.value === timeAtom)?.verdict,
        status: accepted.result.status,
        reason: null,
      };
    });

    expect(results).toEqual(EXPECTED.map((row) => ({ started: 'start', ...row })));
  });
});
