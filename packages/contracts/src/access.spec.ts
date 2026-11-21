import { describe, expect, it } from 'vitest';
import { CreateCatalogModelBodySchema, UpdateCatalogModelBodySchema, modelProvider } from './access';

// One row type for both bodies: the table mixes the two schemas.
type Row = {
  label: string;
  schema: { safeParse: (body: unknown) => { success: boolean } };
  body: Record<string, unknown>;
  valid: boolean;
};
const create = CreateCatalogModelBodySchema;
const update = UpdateCatalogModelBodySchema;

const prices = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.1,
};
const model = {
  id: 'anthropic/claude-haiku-5-5',
  name: 'Haiku',
  purpose: 'chat',
  prices,
  longContext: null,
};

// DD Security Considerations / Input Validation, ADR-0018: the schema is the boundary that keeps an
// invalid catalogue body from reaching the service.
describe('catalogue bodies: a model id is `<provider>/<name>` split at the first slash, and an update changes at least one field', () => {
  it.each<Row>([
    { label: 'id anthropic/a/b', schema: create, body: { ...model, id: 'anthropic/a/b' }, valid: true },
    { label: 'id local/Qwen/Qwen3-32B', schema: create, body: { ...model, id: 'local/Qwen/Qwen3-32B' }, valid: true },
    { label: 'id Foo/x', schema: create, body: { ...model, id: 'Foo/x' }, valid: false },
    { label: 'id x', schema: create, body: { ...model, id: 'x' }, valid: false },
    { label: 'id a/', schema: create, body: { ...model, id: 'a/' }, valid: false },
    { label: 'id a/b c', schema: create, body: { ...model, id: 'a/b c' }, valid: false },
    { label: 'empty update', schema: update, body: {}, valid: false },
  ])('$label -> valid: $valid', ({ schema, body, valid }) => {
    expect(schema.safeParse(body).success).toBe(valid);
  });

  it('takes the provider from the part before the first slash', () => {
    expect(modelProvider('local/Qwen/Qwen3-32B')).toBe('local');
  });
});
