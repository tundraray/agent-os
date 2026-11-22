import { describe, expect, it } from 'vitest';

import {
  type ProviderReadiness,
  type ProviderReadinessInput,
  providerReadiness,
} from './provider-readiness';

// design-core.md, Terms «Готовность провайдера»: the order `missing` → `disabled` → `key_missing` → `ready`,
// the first that holds; a disabled provider without a key is `disabled`, an OpenAI-compatible one needs no key.
const KEY = 'fake-key-0000';

describe('providerReadiness', () => {
  it.each<{
    provider: ProviderReadinessInput | null;
    expected: ProviderReadiness;
  }>([
    { provider: null, expected: 'missing' },
    {
      provider: { kind: 'anthropic', enabled: true, apiKey: KEY },
      expected: 'ready',
    },
    {
      provider: { kind: 'anthropic', enabled: true, apiKey: null },
      expected: 'key_missing',
    },
    {
      provider: { kind: 'anthropic', enabled: false, apiKey: null },
      expected: 'disabled',
    },
    {
      provider: { kind: 'gemini', enabled: true, apiKey: KEY },
      expected: 'ready',
    },
    {
      provider: { kind: 'gemini', enabled: true, apiKey: null },
      expected: 'key_missing',
    },
    {
      provider: { kind: 'gemini', enabled: false, apiKey: KEY },
      expected: 'disabled',
    },
    {
      provider: { kind: 'openai_compatible', enabled: true, apiKey: null },
      expected: 'ready',
    },
    {
      provider: { kind: 'openai_compatible', enabled: false, apiKey: null },
      expected: 'disabled',
    },
  ])('row %# ($provider.kind) → $expected', ({ provider, expected }) => {
    expect(providerReadiness(provider)).toBe(expected);
  });
});
