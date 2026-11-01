import { ModelArgsObjectSchema } from './model-args.js';

// KD-7, design-engine.md (Error handling): the verifier writes each request's `args` as JSON text; text that is not a JSON
// object makes its output invalid, so the gateway retries once and then ends with `invalid_model_output`. Defect caught:
// broken text, an array or a scalar is taken as arguments, or a valid object is refused.
describe('the verifier arguments text', () => {
  it.each<[string, string, boolean]>([
    ['a JSON object', '{"service":"payments","pageSize":50}', true],
    ['an empty JSON object', '{}', true],
    ['text that is not JSON', '{service: payments', false],
    ['a JSON array', '["payments"]', false],
    ['JSON null', 'null', false],
    ['a JSON string', '"payments"', false],
  ])('%s', (_, text, accepted) => {
    expect(ModelArgsObjectSchema.safeParse(text).success).toBe(accepted);
  });
});
