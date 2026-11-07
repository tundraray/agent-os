/** What the reserve of one call is decided over: the investigation's counters, the task's ceiling and this reserve. */
export interface ReserveCounters {
  /** The investigation's token budget. */
  readonly tokenBudget: number;
  /** Tokens charged by closed calls of the investigation. */
  readonly tokensSpent: number;
  /** Tokens held by the investigation's open reservations — of other calls: this one is not reserved yet. */
  readonly tokensReserved: number;
  /** Tokens the task holds across its attempts: open reservations whole, closed rows as charged. */
  readonly taskTokensHeld: number;
  /** The task's ceiling, `TaskBudget.maxTokens`. */
  readonly taskMaxTokens: number;
  /** This call's reservation: counted input + margin + output ceiling (KD-4). */
  readonly reservedTokens: number;
}

/**
 * How the reserve decides (design-engine.md, «Как резерв решает: ждать или отказать», Invariant 6), in this order:
 * `refused` with `investigation_tokens_exhausted` — the spent tokens and this reserve alone exceed the budget, so no
 * wait can make it fit (AC-10.2); `refused` with `task_tokens_exhausted` — the call never fits its own task; `busy` —
 * only the open reserves of other calls keep it out, and it fits once they close (DC-5); otherwise `reserved`.
 * A reserve exactly equal to what is left fits.
 */
export type ReserveDecision =
  | { readonly decision: 'reserved' }
  | { readonly decision: 'busy' }
  | {
      readonly decision: 'refused';
      readonly code: 'investigation_tokens_exhausted' | 'task_tokens_exhausted';
    };

export function decideReserve(counters: ReserveCounters): ReserveDecision {
  const withOwnSpending = counters.tokensSpent + counters.reservedTokens;
  if (withOwnSpending > counters.tokenBudget) {
    return { decision: 'refused', code: 'investigation_tokens_exhausted' };
  }
  if (counters.taskTokensHeld + counters.reservedTokens > counters.taskMaxTokens) {
    return { decision: 'refused', code: 'task_tokens_exhausted' };
  }
  if (withOwnSpending + counters.tokensReserved > counters.tokenBudget) {
    return { decision: 'busy' };
  }
  return { decision: 'reserved' };
}
