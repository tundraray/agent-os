import { describe, expect, it } from 'vitest';
import { CreateModelProviderBodySchema, UpdateModelProviderBodySchema } from './model-providers.js';

// One row type for both bodies: the table mixes the two schemas.
type Row = {
  label: string;
  schema: { safeParse: (body: unknown) => { success: boolean } };
  body: Record<string, unknown>;
  valid: boolean;
};
const create = CreateModelProviderBodySchema;
const update = UpdateModelProviderBodySchema;

const provider = { name: 'google', kind: 'gemini', apiKey: 'k'.repeat(8) };

// DC-1, DC-2 (FR-01): the schema is the boundary that keeps a bad name or key out of the registry and
// lets an update remove the key.
describe('model provider bodies: lowercase name up to 32 from a letter or digit, key of 8 to 512, `apiKey: null` removes the key', () => {
  it.each<Row>([
    { label: 'name Google', schema: create, body: { ...provider, name: 'Google' }, valid: false },
    { label: 'name -x', schema: create, body: { ...provider, name: '-x' }, valid: false },
    { label: 'name of 33', schema: create, body: { ...provider, name: 'a'.repeat(33) }, valid: false },
    { label: 'name local-2', schema: create, body: { ...provider, name: 'local-2' }, valid: true },
    { label: 'key of 7', schema: create, body: { ...provider, apiKey: 'k'.repeat(7) }, valid: false },
    { label: 'key of 513', schema: create, body: { ...provider, apiKey: 'k'.repeat(513) }, valid: false },
    { label: 'key of 8', schema: create, body: { ...provider, apiKey: 'k'.repeat(8) }, valid: true },
    { label: 'key of 512', schema: create, body: { ...provider, apiKey: 'k'.repeat(512) }, valid: true },
    { label: 'update apiKey null', schema: update, body: { apiKey: null }, valid: true },
  ])('$label -> valid: $valid', ({ schema, body, valid }) => {
    expect(schema.safeParse(body).success).toBe(valid);
  });
});
