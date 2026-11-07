import { z } from 'zod';
import { SynthesisOutputSchema } from '../answer/synthesize.handler.js';
import { WorkerOutputSchema } from '../claims/claim.schema.js';
import { ControllerOutputSchema } from '../controller/decision.schema.js';
import { PlanOutputSchema } from '../controller/plan-role.js';
import { ClaimAssessmentSchema } from '../verify/claim-assessment.js';
import { VerifierOutputSchema } from '../verify/verify.handler.js';

// KD-7, T7.3: the provider's native `json_schema` output (and its `count_tokens`) refuses an object schema whose
// `additionalProperties` is anything but `false` — a free-form `args` record stopped every sourced investigation at its
// first controller step with `model_unavailable`. Defect caught: a role output schema, as `ContextBuilder` sends it
// (`z.toJSONSchema`), has an object node without `additionalProperties: false`, at any depth.

/** JSON-pointer-like paths of the object nodes the provider would refuse. */
function openObjects(node: unknown, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((item, index) => openObjects(item, `${path}/${index}`));
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Record<string, unknown>;
  const own = (record.type === 'object' || 'additionalProperties' in record) && record.additionalProperties !== false ? [path || '/'] : [];
  return [...own, ...Object.entries(record).flatMap(([key, value]) => openObjects(value, `${path}/${key}`))];
}

describe('role output schemas as the provider receives them', () => {
  it.each<[string, z.ZodType]>([
    ['plan', PlanOutputSchema],
    ['controller', ControllerOutputSchema],
    ['worker', WorkerOutputSchema],
    ['verifier', VerifierOutputSchema],
    ['verifier ClaimAssessment (DC-14: closed at every level)', ClaimAssessmentSchema],
    ['synthesis', SynthesisOutputSchema],
  ])('%s: every object node has additionalProperties false', (_role, schema) => {
    expect(openObjects(z.toJSONSchema(schema), '')).toEqual([]);
  });
});

// Contracts «Вывод `worker`» and «Вывод `synthesis`» (KD-1, AC-11.1 data half): a claim carries `text`, `atoms` and
// `pointer` — 1 to 20 records grouped by page, each entry a closed object of the page id and its record numbers — and no
// `evidenceIds`; the 1-to-20 rule itself is `checkPointer`'s (pointer.spec.ts), the form keeps the shape (DC-6).
// Defect caught: the provider still asked for the old `evidenceIds`, or a pointer entry accepts other fields.
describe('a worker and a synthesis claim carry a pointer instead of evidenceIds', () => {
  const POINTER_ENTRY = {
    type: 'object',
    properties: { pageId: { type: 'string' }, records: { type: 'array', items: { type: 'number' } } },
    required: ['pageId', 'records'],
    additionalProperties: false,
  };

  it.each<[string, z.ZodType, string[]]>([
    ['worker', WorkerOutputSchema, ['text', 'atoms', 'pointer']],
    ['synthesis', SynthesisOutputSchema, ['text', 'atoms', 'pointer', 'claimId']],
  ])('%s', (_role, schema, fields) => {
    const claim = z.toJSONSchema(schema).properties?.claims;

    expect(claim).toMatchObject({
      items: {
        required: fields,
        additionalProperties: false,
        properties: { pointer: { type: 'array', items: POINTER_ENTRY, description: expect.stringContaining('1 to 20') } },
      },
    });
    expect(claim).not.toHaveProperty(['items', 'properties', 'evidenceIds']);
  });
});

// Contract «Вывод `synthesis`» (KD-4): the draft is the outcome, the ids chosen for the summary and the claims; the
// model writes no summary text. Defect caught: the provider still asked for the `summary` string, so model text could
// reach the summary again, or the choice of ids missing from the form.
describe('a synthesis draft chooses summary claim ids instead of writing a summary', () => {
  it('asks for outcome, summaryClaimIds and claims, and no summary', () => {
    const draft = z.toJSONSchema(SynthesisOutputSchema);

    expect(draft).toMatchObject({
      required: ['outcome', 'summaryClaimIds', 'claims'],
      properties: { summaryClaimIds: { type: 'array', items: { type: 'string' } } },
    });
    expect(draft).not.toHaveProperty(['properties', 'summary']);
  });
});
