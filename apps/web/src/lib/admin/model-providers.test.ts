import { describe, expect, it } from 'vitest';
import { catalogModel, modelProviderView } from '@/test/fixtures';
import { testTranslator } from '@/test/intl';
import { modelOptionName, modelOptions, modelUnavailableReason } from './model-providers';

const providers = [
  modelProviderView({ name: 'anthropic' }),
  modelProviderView({ name: 'google', kind: 'gemini', enabled: false, state: 'disabled' }),
  modelProviderView({ name: 'local', kind: 'openai_compatible', apiKeySet: false, apiKeyLast4: null, state: 'key_missing' }),
];

const catalog = [
  catalogModel({ id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }),
  catalogModel({ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }),
  catalogModel({ id: 'google/gemini-embedding-001', name: 'Gemini Embedding', purpose: 'embedding', inputUsdPerMTok: 0.15, dimensions: 768 }),
  catalogModel({ id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' }),
];

const readiness = (modelId: string) => modelUnavailableReason(modelId, providers);

const t = testTranslator('admin.models');

// AC-13.3, AC-14.1: a model of a provider that does not work gets its reason; purposes never mix; order is provider, then title.
describe('model readiness and choice options (KD-5, UC-3)', () => {
  it.each<[string, () => unknown, unknown]>([
    ['a model whose provider is missing', () => readiness('openai/gpt-5'), 'provider_missing'],
    ['a model of a disabled provider', () => readiness('google/gemini-2.5-flash'), 'provider_disabled'],
    ['a model of a provider without a needed key', () => readiness('local/Qwen/Qwen3-32B'), 'provider_key_missing'],
    ['a model of a ready provider', () => readiness('anthropic/claude-haiku-4-5'), null],
    ['chat options: no embeddings, by provider then title', () => modelOptions({ models: catalog, purpose: 'chat', readinessOf: readiness, locale: 'en' }).map((option) => [option.value, option.label, option.unavailableReason]), [
      ['anthropic/claude-haiku-4-5', 'Claude Haiku 4.5 · anthropic', null],
      ['anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5 · anthropic', null],
      ['google/gemini-2.5-flash', 'Gemini 2.5 Flash · google', 'provider_disabled'],
    ]],
    ['embedding options: only embeddings, labelled with the dimensions', () => modelOptions({ models: catalog, purpose: 'embedding', readinessOf: readiness, locale: 'en' }), [{
      value: 'google/gemini-embedding-001',
      name: 'Gemini Embedding',
      provider: 'google',
      dimensions: 768,
      label: 'Gemini Embedding · google · 768',
      unavailableReason: 'provider_disabled',
    }]],
    ['the option name for a screen reader, with the short reason of a model that does not work', () =>
      modelOptions({ models: catalog, purpose: 'chat', readinessOf: readiness, locale: 'en' }).map((option) => modelOptionName(t, option)), [
      'Claude Haiku 4.5, провайдер anthropic',
      'Claude Sonnet 4.5, провайдер anthropic',
      'Gemini 2.5 Flash, провайдер google, провайдер выключен',
    ]],
  ])('%s', (_name, actual, expected) => {
    expect(actual()).toEqual(expected);
  });
});
