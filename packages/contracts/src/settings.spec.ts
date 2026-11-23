import { describe, expect, it } from 'vitest';
import { parseSettingsValue, type SettingsKey } from './settings';

// R8, KD-3: the key's schema is the only border of a stored value; a value outside it is a failure, never a default.
describe('a stored value that fails its key schema is a failure, not a default', () => {
  it.each<{ key: SettingsKey; value: unknown; valid: boolean }>([
    {
      key: 'sign_in_settings',
      value: { publicUrl: null, idleMinutes: 480, absoluteMinutes: 1440 },
      valid: true,
    },
    { key: 'library_settings', value: { defaultMaxTurns: 40 }, valid: true },
    { key: 'library_settings', value: { defaultMaxTurns: 0 }, valid: false },
    {
      key: 'tool_result_settings',
      value: {
        storeFromChars: 50_000,
        previewChars: 2_000,
        readMaxTokens: 25_000,
      },
      valid: true,
    },
    {
      key: 'tool_result_settings',
      value: {
        storeFromChars: 2_000,
        previewChars: 2_000,
        readMaxTokens: 25_000,
      },
      valid: false,
    },
    {
      key: 'model_defaults',
      value: { chatModel: null, embeddingModel: null },
      valid: true,
    },
    // Another key's form under this key.
    { key: 'model_defaults', value: { defaultMaxTurns: 40 }, valid: false },
    { key: 'library_settings', value: null, valid: false },
  ])('$key $value -> valid: $valid', ({ key, value, valid }) => {
    const parse = () => parseSettingsValue(key, value);
    if (valid) expect(parse()).toEqual(value);
    else expect(parse).toThrow(key);
  });
});
