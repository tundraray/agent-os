import { describe, expect, it } from 'vitest';
import { deepResearchProcessV2 } from '../processes/shipped-processes.js';
import type { EngineRunStatus } from '../runs/engine-runs.repository.js';
import { toInvestigationView } from './investigation-view.js';

const SONNET = 'anthropic/claude-sonnet-5-5';
const HAIKU = 'anthropic/claude-haiku-5-5';

/** A cancelled investigation whose interrupted call left 9 000 tokens reserved (DC-9). */
const cancelled: EngineRunStatus = {
  investigationStatus: 'cancelled',
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
    sourceSnapshots: null,
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

// AC-19.1 in the readers, KD-1 (design-lifecycle.md): the view's status follows the investigation's own status, so
// `completed` appears only once `engine.lifecycle` has closed the investigation. The controller task is no input any
// more: an investigation still `active` after its controller task succeeded reads `running` until it is closed.
// Defects caught: the controller task's outcome deciding the view again; a closed `failed` shown as anything else; a
// conversation being deleted (`deleting`) shown as `running`. (A status outside the column's CHECK is the schema's
// job, proven by the db migration tests: no row for it here.)
describe('toInvestigationView status', () => {
  it.each([
    ['active, also after its controller task succeeded and before the closure,', 'running', 'active'],
    ['completed', 'completed', 'completed'],
    ['failed', 'failed', 'failed'],
    ['cancelled', 'cancelled', 'cancelled'],
    ['being deleted (deleting)', 'cancelled', 'deleting'],
  ])('an investigation %s reads as %s', (_, viewStatus, investigationStatus) => {
    expect(toInvestigationView({ ...cancelled, investigationStatus }, []).status).toBe(viewStatus);
  });
});

// UC-E5 (parse half), Data Model «Ответ движка»: an answer stored before agent-quality — a summary string, no summary
// items, no group, no causal flag — reads with the same schema, the missing fields as an empty list, null and false,
// and its summary string kept. Defect caught: a schema that refuses an old answer (the view of every investigation
// answered before the release fails), or defaults that invent a group, a causal mark or summary items.
describe('toInvestigationView answer', () => {
  it('reads an answer written before agent-quality with empty summary items, no group and no causal flag', () => {
    const claim = (claimId: string, verified: boolean) => ({
      claimId,
      text: `claim ${claimId.slice(-1)}`,
      evidenceIds: ['00000000-0000-4000-8000-0000000000e1'],
      verified,
    });
    const established = claim('00000000-0000-4000-8000-0000000000c1', true);
    const assumed = claim('00000000-0000-4000-8000-0000000000c2', false);
    const old = {
      answerId: '00000000-0000-4000-8000-0000000000a1',
      outcome: 'answered',
      stopReason: null,
      summary: 'the refund failed in payments',
      established: [established],
      assumed: [assumed],
      unknown: [],
      removed: [],
    };

    const { answer } = toInvestigationView(
      { investigationStatus: 'completed', run: { ...cancelled.run, processConfig: deepResearchProcessV2, answerId: old.answerId, answer: old } },
      [],
    );

    expect(answer).toEqual({
      answerId: old.answerId,
      outcome: 'answered',
      stopReason: null,
      summary: 'the refund failed in payments',
      summaryItems: [],
      established: [{ ...established, confidence: null }],
      assumed: [{ ...assumed, causal: false }],
      unknown: [],
      removed: [],
    });
  });
});
