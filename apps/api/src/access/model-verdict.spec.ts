import type { ModelVerdict } from '@agent-os/agents';
import type { CatalogModel } from '@agent-os/contracts';
import { effectiveAccess, type GrantRow } from './effective-access';
import { modelVerdict } from './model-verdict';

const A = 'anthropic/a';
const B = 'anthropic/b';
const MONTH = '2026-11';

const PRICES = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 5,
  cacheWriteUsdPerMTok: 1.25,
  cacheReadUsdPerMTok: 0.1,
};
const LONG_PRICES = {
  inputUsdPerMTok: 2,
  outputUsdPerMTok: 7.5,
  cacheWriteUsdPerMTok: 2.5,
  cacheReadUsdPerMTok: 0.2,
};
/** The catalogue row of `A` with one price. */
const MODEL_A = {
  id: A,
  name: 'A',
  purpose: 'chat',
  provider: 'anthropic',
  prices: PRICES,
  longContext: null,
} satisfies CatalogModel;
/** An embedding model of the catalogue under an allow (model-providers design-core.md, `AccessGate.model`). */
const EMBEDDING: CatalogModel = {
  id: 'google/e',
  name: 'E',
  purpose: 'embedding',
  provider: 'google',
  inputUsdPerMTok: 0.15,
  dimensions: 768,
};
const allowEmbedding: GrantRow = {
  id: 'g5',
  effect: 'allow',
  target: { kind: 'model', model: EMBEDDING.id },
  quotaUsd: null,
};
const ALLOWED: ModelVerdict = { kind: 'allowed', price: PRICES };

const allowA20: GrantRow = {
  id: 'g1',
  effect: 'allow',
  target: { kind: 'model', model: A },
  quotaUsd: 20,
};
const allowANoQuota: GrantRow = {
  id: 'g2',
  effect: 'allow',
  target: { kind: 'model', model: A },
  quotaUsd: null,
};
const allowB: GrantRow = {
  id: 'g3',
  effect: 'allow',
  target: { kind: 'model', model: B },
  quotaUsd: null,
};
const allowServer: GrantRow = {
  id: 'g4',
  effect: 'allow',
  target: { kind: 'server', server: 's' },
  quotaUsd: null,
};

type Row = {
  name: string;
  active: boolean;
  /** `null` — the model is outside the catalogue. */
  catalogued: CatalogModel | null;
  grants: GrantRow[];
  spentUsd: number;
  expected: ModelVerdict;
};

// "Как AccessGate решает о вызове модели", UC-5: AC-16.3, AC-20.2, AC-21.4, DC-6, DC-8.
describe('the model verdict checks the employee, the catalogue, the rights and the quota in this order', () => {
  it.each<Row>([
    {
      name: 'a disabled employee is refused even for a model outside the catalogue',
      active: false,
      catalogued: null,
      grants: [allowA20],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'owner_disabled' },
    },
    {
      name: 'a model outside the catalogue is not connected',
      active: true,
      catalogued: null,
      grants: [allowA20],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'model_not_connected' },
    },
    {
      name: 'an embedding model is not connected for a model call, even under an allow',
      active: true,
      catalogued: EMBEDDING,
      grants: [allowEmbedding],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'model_not_connected' },
    },
    {
      name: 'no model allowed at all',
      active: true,
      catalogued: MODEL_A,
      grants: [allowServer],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'no_models_allowed' },
    },
    {
      name: 'another model allowed',
      active: true,
      catalogued: MODEL_A,
      grants: [allowB],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'model_not_allowed' },
    },
    {
      name: 'spend equal to the quota',
      active: true,
      catalogued: MODEL_A,
      grants: [allowA20],
      spentUsd: 20,
      expected: {
        kind: 'refused',
        reason: 'quota_exhausted',
        spentUsd: 20,
        quotaUsd: 20,
        month: MONTH,
      },
    },
    {
      name: 'spend a cent below the quota',
      active: true,
      catalogued: MODEL_A,
      grants: [allowA20],
      spentUsd: 19.99,
      expected: ALLOWED,
    },
    {
      name: 'no spend this month under a quota',
      active: true,
      catalogued: MODEL_A,
      grants: [allowA20],
      spentUsd: 0,
      expected: ALLOWED,
    },
    {
      name: 'any spend without a limit',
      active: true,
      catalogued: MODEL_A,
      grants: [allowANoQuota],
      spentUsd: 1_000_000,
      expected: ALLOWED,
    },
    {
      name: 'a long-context tier of the catalogue is the price tier above its input size',
      active: true,
      catalogued: {
        ...MODEL_A,
        longContext: { aboveInputTokens: 200_000, prices: LONG_PRICES },
      },
      grants: [allowANoQuota],
      spentUsd: 0,
      expected: {
        kind: 'allowed',
        price: { ...PRICES, above: { ...LONG_PRICES, inputTokens: 200_000 } },
      },
    },
  ])('$name', ({ active, catalogued, grants, spentUsd, expected }) => {
    const verdict = modelVerdict({
      active,
      catalogued: catalogued ?? undefined,
      access: effectiveAccess(grants),
      spentUsd,
      month: MONTH,
    });
    expect(verdict).toEqual(expected);
  });
});
