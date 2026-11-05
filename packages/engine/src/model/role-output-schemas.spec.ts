import { z } from 'zod';
import { SynthesisOutputSchema } from '../answer/synthesize.handler.js';
import { WorkerOutputSchema } from '../claims/claim.schema.js';
import { ControllerOutputSchema } from '../controller/decision.schema.js';
import { PlanOutputSchema } from '../controller/plan-role.js';
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
    ['synthesis', SynthesisOutputSchema],
  ])('%s: every object node has additionalProperties false', (_role, schema) => {
    expect(openObjects(z.toJSONSchema(schema), '')).toEqual([]);
  });
});
