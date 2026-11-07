import type { InvestigationView, Transcript } from '@agent-os/engine';

/** Whether a scenario starts, or is marked «не прогнан» with every scenario after it. */
export type ScenarioAdmission = 'run' | 'not_run';

/**
 * The total token budget of one run of the program (design-self-check.md, Constraints «Бюджет токенов», UC-E8). Its
 * spend is every model call of the run: the investigations by their ledger, and the calls outside investigations —
 * the judge, the judge-check answers and, after the `engine` part, the influence measurement — by the transcripts of
 * `Engine.assess`. Only the investigations' budgets are reserved when a scenario is admitted; the calls outside
 * investigations are charged after they happen, so the limit may be passed, but by no more than those calls of one
 * scenario and the judge-check answers at the end of the run.
 */
export interface RunBudget {
  /**
   * `run` when the remainder covers the budgets of all the scenario's runs; otherwise `not_run`, and so is every
   * scenario asked after it, and the run is unfinished.
   */
  admitScenario(runTokenBudgets: readonly number[]): ScenarioAdmission;
  /** The spend of one investigation as its ledger shows it, open reservations included (`InvestigationView.usage`). */
  chargeInvestigation(
    usage: Pick<InvestigationView['usage'], 'totalTokens'>,
  ): void;
  /**
   * The spend of `Engine.assess` calls by their transcripts. A transcript with a task is a role call of an
   * investigation, already in its ledger, and is not counted again; an unclosed call has no spend yet.
   */
  chargeAssessCalls(
    transcripts: readonly Pick<Transcript, 'taskId' | 'usage'>[],
  ): void;
  spentTokens(): number;
  /** False once a scenario was not run. */
  isComplete(): boolean;
}

/**
 * Tokens a call charges, by the rule the ledger charges role calls with: the whole input — its cached parts are inside
 * it — plus the output.
 */
function chargedTokens(usage: NonNullable<Transcript['usage']>): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** A budget over `limitTokens`, or a budget that admits every scenario when the run has no total limit (null). */
export function createRunBudget(limitTokens: number | null): RunBudget {
  if (
    limitTokens !== null &&
    (!Number.isInteger(limitTokens) || limitTokens <= 0)
  ) {
    throw new Error(
      `The run budget must be a positive integer of tokens, got ${limitTokens}`,
    );
  }
  let spent = 0;
  let complete = true;
  return {
    admitScenario(runTokenBudgets) {
      if (!complete) return 'not_run';
      if (limitTokens === null) return 'run';
      const needed = runTokenBudgets.reduce((sum, tokens) => sum + tokens, 0);
      if (limitTokens - spent >= needed) return 'run';
      complete = false;
      return 'not_run';
    },
    chargeInvestigation({ totalTokens }) {
      spent += totalTokens;
    },
    chargeAssessCalls(transcripts) {
      for (const { taskId, usage } of transcripts) {
        if (taskId === null && usage !== null) spent += chargedTokens(usage);
      }
    },
    spentTokens: () => spent,
    isComplete: () => complete,
  };
}
