import type { RunRecord } from '@agent-os/engine';
import { describe, expect, it } from 'vitest';
import {
  type ItemResult,
  type PlanSourcesMark,
  planNamedKeySourcesShare,
  planSourcesMark,
  type RunEntry,
} from './run-result.js';

// UC-7, AC-10.1 (design-catalog-planning.md, FR-10): the first accepted plan revision of each scenario run is compared
// with the `sources` of the scenario key by ids; the report shows the share of marks «да».

const KEY_SOURCES = ['backoffice', 'fixture'];

const branch = (...sources: string[]) => ({
  question: 'Какие заказы отклонены?',
  approach: 'Сопоставить отказы и способы оплаты.',
  sources,
  sourceReason: 'Отказы видны в логах, способ оплаты — в бэк-офисе.',
});

const revision = (
  number: number,
  ...branches: ReturnType<typeof branch>[]
) => ({
  revision: number,
  plan: { goal: 'Найти причину.', readinessCriteria: [], branches },
});

const record = (
  ...planRevisions: RunRecord['planRevisions'][number][]
): Pick<RunRecord, 'planRevisions'> => ({ planRevisions });

const RUN: RunEntry = {
  investigationId: 'inv',
  status: 'completed',
  answerOutcome: 'answered',
  stopReason: null,
  verdict: { verdict: 'passed', reason: 'passed' },
  firstError: null,
  modelCalls: 3,
  unverifiedByRefusal: 0,
  tokens: 100,
  costUsd: 1,
  establishedClaims: 1,
  contradictingClaims: 0,
  signals: null,
};

const scenario = (scenarioId: string, mark: PlanSourcesMark): ItemResult => ({
  item: { scenarioId },
  kind: 'cause',
  ran: true,
  runs: [{ ...RUN, investigationId: `${scenarioId}-run`, ...mark }],
});

describe('plan sources of a self-check run', () => {
  it('names whether the first accepted revision named the key sources', () => {
    // Two scenarios whose first plan names both sources — one across two branches, one with a later revision that
    // would not — and one whose first plan names only `fixture`, though its second revision adds `backoffice`.
    const both = planSourcesMark(
      record(revision(1, branch('fixture'), branch('backoffice', 'fixture'))),
      KEY_SOURCES,
    );
    const bothThenNarrowed = planSourcesMark(
      record(
        revision(2, branch('fixture')),
        revision(1, branch('backoffice', 'fixture')),
      ),
      KEY_SOURCES,
    );
    const onlyFixture = planSourcesMark(
      record(
        revision(1, branch('fixture'), branch('fixture')),
        revision(2, branch('backoffice', 'fixture')),
      ),
      KEY_SOURCES,
    );

    expect([both, bothThenNarrowed, onlyFixture]).toEqual([
      { planSources: ['fixture', 'backoffice'], planNamedKeySources: true },
      { planSources: ['backoffice', 'fixture'], planNamedKeySources: true },
      { planSources: ['fixture'], planNamedKeySources: false },
    ]);
    const share = planNamedKeySourcesShare([
      scenario('sc-1', both),
      scenario('sc-2', bothThenNarrowed),
      scenario('sc-3', onlyFixture),
    ]);
    expect(share).toEqual({ named: 2, total: 3 });
  });

  it('marks a run without an accepted plan false', () => {
    expect(planSourcesMark(record(), ['fixture'])).toEqual({
      planSources: null,
      planNamedKeySources: false,
    });
  });
});
