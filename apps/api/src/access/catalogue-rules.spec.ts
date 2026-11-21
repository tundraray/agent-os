import type { CatalogModel } from '@agent-os/contracts';
import { modelAdditionRule, modelDefaultsRule } from './catalogue-rules';

const CHAT: CatalogModel = {
  id: 'anthropic/claude-haiku-4-5',
  name: 'Haiku',
  purpose: 'chat',
  provider: 'anthropic',
  prices: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.1,
  },
  longContext: null,
};
const EMBEDDING: CatalogModel = {
  id: 'google/gemini-embedding-001',
  name: 'Gemini embedding',
  purpose: 'embedding',
  provider: 'google',
  inputUsdPerMTok: 0.15,
  dimensions: 768,
};

type Row = { name: string; decide: () => unknown; expected: unknown };

// design-core.md, «Правила каталога» and PUT /api/admin/model-defaults: AC-05.1, AC-05.2, AC-05.3, AC-06.2.
describe('the catalogue takes a model only on a known provider of a fitting kind, and a default only of its purpose', () => {
  it.each<Row>([
    {
      name: 'AC-05.1: an embedding model on a gemini provider is accepted',
      decide: () =>
        modelAdditionRule({ purpose: 'embedding', providerKind: 'gemini' }),
      expected: { kind: 'ok' },
    },
    {
      name: 'AC-05.2: an embedding model on an anthropic provider is refused',
      decide: () =>
        modelAdditionRule({ purpose: 'embedding', providerKind: 'anthropic' }),
      expected: { kind: 'invalid', reason: 'embeddings_not_supported' },
    },
    {
      name: 'a chat model on an anthropic provider is accepted',
      decide: () =>
        modelAdditionRule({ purpose: 'chat', providerKind: 'anthropic' }),
      expected: { kind: 'ok' },
    },
    {
      name: 'AC-05.3: a model of a provider that is not registered is refused',
      decide: () => modelAdditionRule({ purpose: 'chat', providerKind: null }),
      expected: { kind: 'invalid', reason: 'provider_unknown' },
    },
    {
      name: 'AC-06.2: an embedding model as the default chat model is refused',
      decide: () =>
        modelDefaultsRule([
          { purpose: 'chat', model: EMBEDDING.id, catalogued: EMBEDDING },
        ]),
      expected: { kind: 'invalid', reason: 'not_chat', model: EMBEDDING.id },
    },
    {
      name: 'AC-06.2: a chat model as the default embedding model is refused',
      decide: () =>
        modelDefaultsRule([
          { purpose: 'chat', model: CHAT.id, catalogued: CHAT },
          { purpose: 'embedding', model: CHAT.id, catalogued: CHAT },
        ]),
      expected: { kind: 'invalid', reason: 'not_embedding', model: CHAT.id },
    },
    {
      name: 'AC-06.2: a default outside the catalogue is refused',
      decide: () =>
        modelDefaultsRule([
          { purpose: 'chat', model: 'anthropic/gone', catalogued: undefined },
        ]),
      expected: {
        kind: 'invalid',
        reason: 'model_unknown',
        model: 'anthropic/gone',
      },
    },
    {
      name: 'defaults of their purposes are accepted',
      decide: () =>
        modelDefaultsRule([
          { purpose: 'chat', model: CHAT.id, catalogued: CHAT },
          { purpose: 'embedding', model: EMBEDDING.id, catalogued: EMBEDDING },
        ]),
      expected: { kind: 'ok' },
    },
  ])('$name', ({ decide, expected }) => {
    expect(decide()).toEqual(expected);
  });
});
