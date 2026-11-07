import type { Transcript } from '@agent-os/engine';
import { describe, expect, it } from 'vitest';
import { createRunBudget, type RunBudget } from './run-budget.js';

// UC-E8, Constraints «Бюджет токенов»: the run's spend counts every model call — the investigations by the ledger, the
// judge and the judge-check answers by the transcripts of Engine.assess; a scenario starts only when the remainder
// covers the budgets of all its runs, and the calls outside investigations are not reserved beforehand.

/** Three runs of 100 tokens each. */
const SCENARIO = [100, 100, 100] as const;

/** A closed `Engine.assess` transcript: outside any task. */
const assessCall = (
  inputTokens: number,
  outputTokens: number,
): Pick<Transcript, 'taskId' | 'usage'> => ({
  taskId: null,
  usage: {
    inputTokens,
    outputTokens,
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
    costUsd: '0.001',
  },
});

type Step =
  | { readonly admit: readonly number[] }
  | { readonly investigation: number }
  | { readonly assess: readonly Pick<Transcript, 'taskId' | 'usage'>[] };

function play(budget: RunBudget, steps: readonly Step[]): string[] {
  const decisions: string[] = [];
  for (const step of steps) {
    if ('admit' in step) decisions.push(budget.admitScenario(step.admit));
    else if ('investigation' in step)
      budget.chargeInvestigation({ totalTokens: step.investigation });
    else budget.chargeAssessCalls(step.assess);
  }
  return decisions;
}

describe('createRunBudget', () => {
  it.each<{
    name: string;
    limit: number | null;
    steps: readonly Step[];
    decisions: readonly string[];
    complete: boolean;
    spent: number;
  }>([
    {
      name: 'no limit: every scenario runs',
      limit: null,
      steps: [
        { admit: SCENARIO },
        { investigation: 5_000 },
        { admit: SCENARIO },
      ],
      decisions: ['run', 'run'],
      complete: true,
      spent: 5_000,
    },
    {
      name: 'UC-E8: enough for two scenarios of three -> the third is not run and the run is unfinished',
      limit: 600,
      steps: [
        { admit: SCENARIO },
        { investigation: 300 },
        { admit: SCENARIO },
        { investigation: 250 },
        { admit: SCENARIO },
      ],
      decisions: ['run', 'run', 'not_run'],
      complete: false,
      spent: 550,
    },
    {
      name: 'once a scenario is not run, the rest are not run either',
      limit: 400,
      steps: [
        { admit: SCENARIO },
        { investigation: 300 },
        { admit: SCENARIO },
        { admit: [50] },
      ],
      decisions: ['run', 'not_run', 'not_run'],
      complete: false,
      spent: 300,
    },
    {
      name: 'judge spend reduces the remainder: 250 + 60 leaves 290, short of 300',
      limit: 600,
      steps: [
        { admit: SCENARIO },
        { investigation: 250 },
        { assess: [assessCall(40, 20)] },
        { admit: SCENARIO },
      ],
      decisions: ['run', 'not_run'],
      complete: false,
      spent: 310,
    },
    {
      name: 'the same 310 spent by investigations alone gives the same decision',
      limit: 600,
      steps: [{ admit: SCENARIO }, { investigation: 310 }, { admit: SCENARIO }],
      decisions: ['run', 'not_run'],
      complete: false,
      spent: 310,
    },
    {
      name: 'without the judge spend the same scenario would run',
      limit: 600,
      steps: [{ admit: SCENARIO }, { investigation: 250 }, { admit: SCENARIO }],
      decisions: ['run', 'run'],
      complete: true,
      spent: 250,
    },
    {
      name: 'a remainder enough for the runs but not for the judge after them does not stop the scenario',
      limit: 300,
      steps: [
        { admit: SCENARIO },
        { investigation: 300 },
        { assess: [assessCall(30, 10), assessCall(5, 5)] },
      ],
      decisions: ['run'],
      complete: true,
      spent: 350,
    },
    {
      name: 'judge-check answers at the end of the run are counted past the limit',
      limit: 300,
      steps: [
        { admit: SCENARIO },
        { investigation: 300 },
        { assess: [assessCall(80, 20)] },
        { admit: SCENARIO },
      ],
      decisions: ['run', 'not_run'],
      complete: false,
      spent: 400,
    },
    {
      name: 'role calls of an investigation (with a task) are already in the ledger; an unclosed call counts nothing',
      limit: 600,
      steps: [
        { admit: SCENARIO },
        { investigation: 290 },
        {
          assess: [
            {
              taskId: 'task-1',
              usage: {
                inputTokens: 500,
                outputTokens: 100,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: '0.1',
              },
            },
            { taskId: null, usage: null },
            {
              taskId: null,
              usage: {
                inputTokens: null,
                outputTokens: null,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                costUsd: '0',
              },
            },
          ],
        },
        { admit: SCENARIO },
      ],
      decisions: ['run', 'run'],
      complete: true,
      spent: 290,
    },
  ])('$name', ({ limit, steps, decisions, complete, spent }) => {
    const budget = createRunBudget(limit);

    expect(play(budget, steps)).toEqual(decisions);
    expect(budget.isComplete()).toBe(complete);
    expect(budget.spentTokens()).toBe(spent);
  });

  it.each([0, -1, 1.5])(
    'refuses a limit that is not a positive integer: %s',
    (limit) => {
      expect(() => createRunBudget(limit)).toThrow(/positive integer/);
    },
  );
});
