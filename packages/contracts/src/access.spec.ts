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
const longContext = (aboveInputTokens: number) => ({ aboveInputTokens, prices });

// DD Security Considerations / Input Validation: the schema is the boundary that keeps an invalid
// catalogue body from reaching the service.
describe('catalogue bodies: model id `anthropic/<name>`, name 1–80, prices not negative, long-context threshold an integer above zero', () => {
  it.each<Row>([
    { label: 'valid model', schema: create, body: model, valid: true },
    { label: 'name of 0 chars', schema: create, body: { ...model, name: '' }, valid: false },
    { label: 'name of 1 char', schema: create, body: { ...model, name: 'H' }, valid: true },
    { label: 'name of 80 chars', schema: create, body: { ...model, name: 'h'.repeat(80) }, valid: true },
    { label: 'name of 81 chars', schema: create, body: { ...model, name: 'h'.repeat(81) }, valid: false },
    { label: 'id openai/x', schema: create, body: { ...model, id: 'openai/x' }, valid: false },
    { label: 'id anthropic/a/b', schema: create, body: { ...model, id: 'anthropic/a/b' }, valid: false },
    { label: 'zero price', schema: create, body: { ...model, prices: { ...prices, cacheReadUsdPerMTok: 0 } }, valid: true },
    { label: 'negative price', schema: create, body: { ...model, prices: { ...prices, inputUsdPerMTok: -0.01 } }, valid: false },
    { label: 'long context 200000', schema: create, body: { ...model, longContext: longContext(200_000) }, valid: true },
    { label: 'long context threshold 0', schema: create, body: { ...model, longContext: longContext(0) }, valid: false },
    { label: 'long context threshold 1.5', schema: create, body: { ...model, longContext: longContext(1.5) }, valid: false },
    { label: 'update name', schema: update, body: { name: 'Haiku 5.5' }, valid: true },
    { label: 'update long context to null', schema: update, body: { longContext: null }, valid: true },
    { label: 'empty update', schema: update, body: {}, valid: false },
    { label: 'update with id', schema: update, body: { name: 'Haiku', id: 'anthropic/other' }, valid: false },
  ])('$label -> valid: $valid', ({ schema, body, valid }) => {
    expect(schema.safeParse(body).success).toBe(valid);
  });
});
