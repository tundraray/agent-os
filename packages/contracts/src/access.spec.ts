import { describe, expect, it } from 'vitest';
import { CreateCatalogModelBodySchema, UpdateCatalogModelBodySchema } from './access.js';

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
const model = { id: 'anthropic/claude-haiku-5-5', name: 'Haiku', prices, longContext: null };

// DD Security Considerations / Input Validation: the schema is the boundary that keeps an invalid
// catalogue body from reaching the service.
describe('catalogue bodies: a model id is `anthropic/<name>` with one segment, and an update changes at least one field', () => {
  it.each<Row>([
    { label: 'id openai/x', schema: create, body: { ...model, id: 'openai/x' }, valid: false },
    { label: 'id anthropic/a/b', schema: create, body: { ...model, id: 'anthropic/a/b' }, valid: false },
    { label: 'empty update', schema: update, body: {}, valid: false },
  ])('$label -> valid: $valid', ({ schema, body, valid }) => {
    expect(schema.safeParse(body).success).toBe(valid);
  });
});
