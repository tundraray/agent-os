import { describe, expect, it } from 'vitest';
import { UpdateKnowledgeSettingsBodySchema } from './knowledge';

const settings = { limitTokens: 8000, lessonsEnabled: true };

// FR-06 (settings bounds): the schema is the boundary that answers 400 VALIDATION_FAILED and keeps a limit out of
// 1 000…32 000, a fractional limit or a stray field out of the settings row.
describe('knowledge settings body: integer limit of 1 000 to 32 000, no other fields', () => {
  it.each([
    {
      label: 'limit 999',
      body: { ...settings, limitTokens: 999 },
      valid: false,
    },
    {
      label: 'limit 32 001',
      body: { ...settings, limitTokens: 32_001 },
      valid: false,
    },
    {
      label: 'limit 8000.5',
      body: { ...settings, limitTokens: 8000.5 },
      valid: false,
    },
    {
      label: 'limit 1 000',
      body: { ...settings, limitTokens: 1000 },
      valid: true,
    },
    {
      label: 'limit 32 000',
      body: { ...settings, limitTokens: 32_000 },
      valid: true,
    },
    {
      label: 'stray field',
      body: { ...settings, updatedAt: null },
      valid: false,
    },
  ])('$label -> valid: $valid', ({ body, valid }) => {
    expect(UpdateKnowledgeSettingsBodySchema.safeParse(body).success).toBe(
      valid,
    );
  });
});
