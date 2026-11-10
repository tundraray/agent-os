import type { RuntimeTx } from '@agent-os/runtime';
import type { AgentRunContext } from '../../agents/tools/tool-context.js';
import { attemptsExhausted, type PlanWriteOutcome } from '../plan-attempts.js';
import { createPlanWriteTool, PLAN_WRITE_ENTRY } from './plan-write.js';

// DC-5, DC-6, AC-06.1 (the rule), Invariant 5 of design-catalog-planning.md: `plan_write` checks each branch's sources
// against the planner's run sources by id, and the one definition of «попытки плана исчерпаны» counts the series.
// Defects caught: a plan written with a source outside the catalog or a branch with no source; a refusal without the
// branch number or the id the model wrote; a revision written on a refusal; a series counted wrong (not reset by an
// accepted revision, broken or extended by `plan_attempts_exhausted` or a schema refusal); a check run after exhaustion.
// Boundary doubles: the guarded transaction (lock, last revision, insert) and the list of earlier `plan_write` outcomes.

const INVESTIGATION_ID = '00000000-0000-4000-8000-0000000000aa';
const GOAL = 'Find why payments time out';
const RUN_SOURCES = ['fixture', 'backoffice'];

const ARGS_SCHEMA = (() => {
  const schema = PLAN_WRITE_ENTRY.argsSchema;
  if (schema === 'result_form') throw new Error('plan_write has its own argument schema');
  return schema;
})();

const RUN = { investigationId: INVESTIGATION_ID, sources: RUN_SOURCES, config: { goal: GOAL } } as unknown as AgentRunContext;

const branch = (sources: readonly string[], question = 'What did payment-api log?') => ({
  question,
  approach: 'search its errors',
  sources,
  sourceReason: 'it holds the service logs',
});

const planArgs = (branches: readonly ReturnType<typeof branch>[]) => ({
  readinessCriteria: ['the cause is named'],
  branches,
  reason: 'there is no plan yet',
});

/** A guarded transaction that records the lock and the inserted revisions; the plan's last revision is `latest`. */
function fakeTx(latest: number | null) {
  const inserted: Record<string, unknown>[] = [];
  let locked = false;
  const tx = {
    execute: async () => {
      locked = true;
    },
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => (latest === null ? [] : [{ revision: latest }]) }),
        }),
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (!locked) throw new Error('a revision written outside the advisory lock');
        inserted.push(row);
      },
    }),
  } as unknown as RuntimeTx;
  return { tx, inserted };
}

async function callPlanWrite(args: unknown, options: { readonly outcomes?: readonly PlanWriteOutcome[]; readonly latest?: number | null } = {}) {
  const { tx, inserted } = fakeTx(options.latest ?? null);
  const tool = createPlanWriteTool({ read: async () => options.outcomes ?? [] });
  const ending = await tool.run({ tx, run: RUN, call: {} as never, args: ARGS_SCHEMA.parse(args) });
  return { ending, inserted };
}

describe('plan_write', () => {
  describe('checks branch sources against the run sources', () => {
    it.each([
      {
        name: 'a branch with no source',
        branches: [branch(['fixture']), branch([], 'What did the back office record?')],
        detail: { branches: [{ branch: 2, noSource: true }] },
      },
      {
        name: 'a source outside the run sources, as the model wrote it',
        branches: [branch(['tickets'])],
        detail: { branches: [{ branch: 1, notInCatalog: ['tickets'] }] },
      },
      {
        name: 'a branch mixing a catalog source and one outside it, plus a branch with no source',
        branches: [branch([]), branch(['fixture', 'Backoffice', 'Backoffice'])],
        detail: { branches: [{ branch: 1, noSource: true }, { branch: 2, notInCatalog: ['Backoffice'] }] },
      },
    ])('rejects $name with plan_sources_invalid, the branch number and the ids, and writes no revision', async ({ branches, detail }) => {
      const { ending, inserted } = await callPlanWrite(planArgs(branches));

      expect(ending).toEqual({ to: 'rejected', outcome: 'rejected', reason: 'plan_sources_invalid', detail });
      expect(inserted).toEqual([]);
    });

    it('writes the next revision with each branch sources and reason when every source is in the catalog', async () => {
      const branches = [branch(['fixture']), branch(['fixture', 'backoffice'], 'What did the back office record?')];

      const { ending, inserted } = await callPlanWrite(planArgs(branches), { latest: 2, outcomes: ['accepted', 'sources_rejected'] });

      expect(ending).toEqual({ to: 'done', outcome: 'success', result: { revision: 3 } });
      expect(inserted).toEqual([
        {
          investigationId: INVESTIGATION_ID,
          revision: 3,
          plan: {
            goal: GOAL,
            readinessCriteria: ['the cause is named'],
            branches: [
              { question: 'What did payment-api log?', approach: 'search its errors', sources: ['fixture'], sourceReason: 'it holds the service logs' },
              {
                question: 'What did the back office record?',
                approach: 'search its errors',
                sources: ['fixture', 'backoffice'],
                sourceReason: 'it holds the service logs',
              },
            ],
          },
          reason: 'there is no plan yet',
        },
      ]);
    });

    it.each([
      { name: 'no source (the check, not the schema, refuses it)', patch: { sources: [] }, valid: true },
      { name: 'eight sources', patch: { sources: Array.from({ length: 8 }, (_, i) => `s${i}`) }, valid: true },
      { name: 'nine sources', patch: { sources: Array.from({ length: 9 }, (_, i) => `s${i}`) }, valid: false },
      { name: 'an empty source reason', patch: { sourceReason: '' }, valid: false },
      { name: 'a source reason of 500 characters', patch: { sourceReason: 'r'.repeat(500) }, valid: true },
      { name: 'a source reason of 501 characters', patch: { sourceReason: 'r'.repeat(501) }, valid: false },
      { name: 'no sources field', patch: { sources: undefined }, valid: false },
      { name: 'no source reason field', patch: { sourceReason: undefined }, valid: false },
    ])('the argument schema checks only the form of a branch: $name', ({ patch, valid }) => {
      const args = planArgs([{ ...branch(['fixture']), ...patch } as unknown as ReturnType<typeof branch>]);

      expect(ARGS_SCHEMA.safeParse(args).success).toBe(valid);
    });
  });

  describe('counts attempts', () => {
    const R = 'sources_rejected' as const;
    const A = 'accepted' as const;
    const N = 'not_an_attempt' as const;

    it.each<{ name: string; outcomes: PlanWriteOutcome[]; exhausted: boolean }>([
      { name: 'no call yet', outcomes: [], exhausted: false },
      { name: 'two rejections', outcomes: [R, R], exhausted: false },
      { name: 'three rejections in a row from the start', outcomes: [R, R, R], exhausted: true },
      { name: 'three rejections after an accepted revision', outcomes: [R, R, A, R, R, R], exhausted: true },
      { name: 'an accepted revision resets the series', outcomes: [R, R, A, R, R], exhausted: false },
      { name: 'refusals that are not attempts neither count nor break the series', outcomes: [R, N, R, N, N, R], exhausted: true },
      { name: 'refusals that are not attempts do not count on their own', outcomes: [R, R, N, N, N], exhausted: false },
    ])('$name -> exhausted $exhausted', ({ outcomes, exhausted }) => {
      expect(attemptsExhausted(outcomes)).toBe(exhausted);
    });

    it.each([
      { name: 'a valid plan', branches: [branch(['fixture'])] },
      { name: 'a plan with a source outside the catalog', branches: [branch(['tickets'])] },
    ])('refuses $name with plan_attempts_exhausted, no check and no revision once the attempts are exhausted', async ({ branches }) => {
      const { ending, inserted } = await callPlanWrite(planArgs(branches), { latest: 1, outcomes: [A, R, N, R, R] });

      expect(ending).toEqual({ to: 'rejected', outcome: 'rejected', reason: 'plan_attempts_exhausted' });
      expect(inserted).toEqual([]);
    });
  });
});
