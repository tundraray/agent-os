import { describe, expect, it } from 'vitest';
import type { EngineRunStatus } from '../runs/engine-runs.repository.js';
import { toInvestigationView } from './investigation-view.js';

const SONNET = 'anthropic/claude-sonnet-5-5';
const HAIKU = 'anthropic/claude-haiku-5-5';

/** A cancelled investigation whose interrupted call left 9 000 tokens reserved (DC-9). */
const cancelled: EngineRunStatus = {
  investigationStatus: 'cancelled',
  controllerTaskStatus: 'cancelled',
  run: {
    investigationId: '00000000-0000-4000-8000-000000000001',
    resourceId: 'user-1',
    launchKey: 'launch-1',
    processId: 'deep-research',
    processVersion: 1,
    processConfig: {},
    sourceMode: 'sources',
    controllerTaskId: '00000000-0000-4000-8000-000000000002',
    tokenBudget: 50_000,
    tokensReserved: 9_000,
    tokensSpent: 1_500,
    answerId: null,
    answer: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
  },
};

const ledgerRow = (role: string, model: string, costUsd: string) => ({
  role,
  model,
  calls: 1,
  inputTokens: 400,
  outputTokens: 100,
  cacheReadTokens: 30,
  cacheWriteTokens: 10,
  costUsd,
});

// AC-11.1, DC-9: the usage of the view — rows in role order, costs as numbers, and a total that counts open reservations.
describe('toInvestigationView usage', () => {
  it('orders the ledger by role and totals the charged tokens with the open reservations', () => {
    const { usage } = toInvestigationView(cancelled, [
      ledgerRow('worker', HAIKU, '0.00009000'),
      ledgerRow('controller', SONNET, '0.00180000'),
      ledgerRow('plan', SONNET, '0.00180000'),
    ]);

    expect(usage.byRoleAndModel.map((row) => [row.role, row.model, row.costUsd])).toEqual([
      ['plan', SONNET, 0.0018],
      ['controller', SONNET, 0.0018],
      ['worker', HAIKU, 0.00009],
    ]);
    expect(usage.totalTokens).toBe(10_500);
    expect(usage.totalCostUsd).toBeCloseTo(0.00369, 10);
    expect(usage.tokenBudget).toBe(50_000);
  });
});
