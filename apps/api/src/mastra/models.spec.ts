import { DEFAULT_MODEL, parseModelId, providerOptionsFor } from './models.js';

describe('parseModelId', () => {
  it('falls back to the default model when unset', () => {
    expect(parseModelId(undefined)).toBe(DEFAULT_MODEL);
    expect(parseModelId('')).toBe(DEFAULT_MODEL);
  });

  it('accepts "<provider>/<model>" ids', () => {
    expect(parseModelId('anthropic/claude-haiku-5-5')).toBe(
      'anthropic/claude-haiku-5-5',
    );
    expect(parseModelId('openai/gpt-5-5')).toBe('openai/gpt-5-5');
  });

  it('rejects ids without a provider', () => {
    expect(() => parseModelId('claude-haiku-5-5')).toThrow(/provider/);
  });
});

describe('providerOptionsFor', () => {
  it('passes effort, adaptive thinking and prompt caching to Anthropic', () => {
    const { anthropic } = providerOptionsFor('high');
    expect(anthropic.effort).toBe('high');
    expect(anthropic.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(anthropic.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('caps OpenAI reasoning effort at "high"', () => {
    expect(providerOptionsFor('max').openai.reasoningEffort).toBe('high');
    expect(providerOptionsFor('low').openai.reasoningEffort).toBe('low');
  });
});
