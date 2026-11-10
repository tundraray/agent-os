import { describe, expect, it } from 'vitest';
import { deepResearchProcessV3 } from '../processes/shipped-processes.js';
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
    definitionMemorySnapshot: null,
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

// AC-11.1, DC-9: the usage of the view — rows by model, costs as numbers, and a total that counts open reservations; a
// ledger role other than `agent` is a defect. Defects caught: a cost kept as text, a total without the open reservations,
// a row of an unknown role shown instead of failing.
describe('toInvestigationView usage', () => {
  it('orders the ledger by model and totals the charged tokens with the open reservations', () => {
    const { usage } = toInvestigationView(cancelled, [
      ledgerRow('agent', SONNET, '0.00180000'),
      ledgerRow('agent', HAIKU, '0.00009000'),
    ]);

    expect(usage.byRoleAndModel.map((row) => [row.role, row.model, row.costUsd])).toEqual([
      ['agent', HAIKU, 0.00009],
      ['agent', SONNET, 0.0018],
    ]);
    expect(usage.totalTokens).toBe(10_500);
    expect(usage.totalCostUsd).toBeCloseTo(0.00189, 10);
    expect(usage.tokenBudget).toBe(50_000);
  });

  it('refuses a ledger row of a role the engine does not write', () => {
    expect(() => toInvestigationView(cancelled, [ledgerRow('worker', HAIKU, '0.00009000')])).toThrow(
      'research_llm_calls.role holds an unknown role worker',
    );
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
      { investigationStatus: 'completed', run: { ...cancelled.run, processConfig: deepResearchProcessV3, answerId: old.answerId, answer: old } },
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

// DC-29 (FR-09, UC-1 — the unit half): the frozen copy of an agents-form investigation is read with the schema of
// either form, chosen by the `agents` key, as the load chooses it; the answer is laid out in that copy's
// `answer.sections`, and the ledger's agent turns read as one row of the role `agent`.
// Defect caught: the view parsed with `ProcessConfigSchema` only, so reading an agents-form investigation throws.
describe('вид расследования формы агентов', () => {
  const AGENTS_CONFIG = {
    processId: 'agent-probe',
    version: 1,
    goal: 'Find the cause of the failures',
    sources: [],
    agents: {
      lead: {
        model: HAIKU,
        effort: 'low',
        prompt: 'Investigate {{query}}.',
        tools: [],
        calls: [],
        result: 'text',
        limits: {
          maxTurns: 4,
          maxCallsPerTurn: 2,
          maxChildren: 0,
          runTokens: 120_000,
          deadlineMs: 600_000,
          windowTokens: 100_000,
          marginTokens: 1_000,
          maxOutputTokens: 2_000,
        },
      },
    },
    rootAgent: 'lead',
    agentLimits: { maxDepth: 1 },
    limits: { investigationTokens: { default: 300_000, max: 300_000 }, maxTasks: 10, maxToolCalls: 10 },
    answer: { sections: ['summary', 'unknown'] },
  };

  it('reads the frozen agents-form copy: the answer by its sections, the agent turns as the role agent', () => {
    const answered = {
      answerId: '00000000-0000-4000-8000-0000000000a2',
      outcome: 'answered',
      stopReason: null,
      summary: 'the job fails on a full disk',
      summaryItems: [],
      established: [],
      assumed: [],
      unknown: [],
      removed: [],
    };

    const view = toInvestigationView(
      {
        investigationStatus: 'completed',
        run: { ...cancelled.run, processId: 'agent-probe', processConfig: AGENTS_CONFIG, answerId: answered.answerId, answer: answered },
      },
      [ledgerRow('agent', HAIKU, '0.00009000')],
    );

    expect(view.answer).toEqual({
      answerId: answered.answerId,
      outcome: 'answered',
      stopReason: null,
      summary: 'the job fails on a full disk',
      summaryItems: [],
      unknown: [],
    });
    expect(view.usage.byRoleAndModel.map((row) => [row.role, row.model, row.calls])).toEqual([['agent', HAIKU, 1]]);
  });
});
