import { effectiveAccess, type GrantRow } from './effective-access.js';
import { modelVerdict, type ModelVerdict } from './model-verdict.js';

const A = 'anthropic/a';
const B = 'anthropic/b';
const MONTH = '2026-11';

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
  catalogued: boolean;
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
      catalogued: false,
      grants: [allowA20],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'owner_disabled' },
    },
    {
      name: 'a model outside the catalogue is not connected',
      active: true,
      catalogued: false,
      grants: [allowA20],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'model_not_connected' },
    },
    {
      name: 'no model allowed at all',
      active: true,
      catalogued: true,
      grants: [allowServer],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'no_models_allowed' },
    },
    {
      name: 'another model allowed',
      active: true,
      catalogued: true,
      grants: [allowB],
      spentUsd: 0,
      expected: { kind: 'refused', reason: 'model_not_allowed' },
    },
    {
      name: 'spend equal to the quota',
      active: true,
      catalogued: true,
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
      catalogued: true,
      grants: [allowA20],
      spentUsd: 19.99,
      expected: { kind: 'allowed' },
    },
    {
      name: 'no spend this month under a quota',
      active: true,
      catalogued: true,
      grants: [allowA20],
      spentUsd: 0,
      expected: { kind: 'allowed' },
    },
    {
      name: 'any spend without a limit',
      active: true,
      catalogued: true,
      grants: [allowANoQuota],
      spentUsd: 1_000_000,
      expected: { kind: 'allowed' },
    },
  ])('$name', ({ active, catalogued, grants, spentUsd, expected }) => {
    const verdict = modelVerdict({
      active,
      catalogued,
      model: A,
      access: effectiveAccess(grants),
      spentUsd,
      month: MONTH,
    });
    expect(verdict).toEqual(expected);
  });
});
