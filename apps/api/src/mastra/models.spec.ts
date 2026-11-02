import {
  DEFAULT_MODEL,
  parseModelId,
  providerOptionsFor,
  type ReasoningEffort,
  researchTurnProviderOptions,
} from './models.js';

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

// KD-1, KD-9: a research turn keeps the agent's provider options, turns Anthropic thinking off and caps the effort at
// "high" (Haiku 5.5 turns thinking off only up to it).
describe('researchTurnProviderOptions', () => {
  it.each<[ReasoningEffort, ReasoningEffort]>([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ])('effort %s runs as %s with thinking off', (effort, capped) => {
    const { anthropic, openai } = researchTurnProviderOptions(effort);
    expect(anthropic).toEqual({
      thinking: { type: 'disabled' },
      effort: capped,
      cacheControl: { type: 'ephemeral' },
    });
    expect(openai).toEqual({ reasoningEffort: capped });
  });
});
