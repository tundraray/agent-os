/**
 * The token share of a tree of runs (design-agent-core.md, KD-4, «Как считается доля бюджета»): pure rules over numbers
 * the ledger reads. A run's ceiling is its share (the root's is the investigation's budget); what it occupies is its own
 * spending plus, for each child, the whole share while the child's subtree has a task in work and the subtree's actual
 * spending once it has none. The rest of the ceiling is free, and a child's share comes out of it.
 */

/** What one child holds of its parent's ceiling. */
export interface ChildHolding {
  /** The share the parent granted the child. */
  readonly shareTokens: number;
  /**
   * A task of the child's subtree, the child's own included, is not final yet — or the call has no task yet (`starting`):
   * the whole share stays taken, even when the child itself already failed (DC-9).
   */
  readonly subtreeInWork: boolean;
  /** What the subtree spent by the ledger: charged rows, and open reservations whole. */
  readonly subtreeSpentTokens: number;
}

/** What a run occupies of its ceiling (invariant 6). */
export function occupiedTokens(input: {
  /** The run's own spending across its attempts: charged rows, and open reservations whole. */
  readonly ownTokens: number;
  readonly children: readonly ChildHolding[];
}): number {
  return input.children.reduce(
    (occupied, child) => occupied + (child.subtreeInWork ? child.shareTokens : child.subtreeSpentTokens),
    input.ownTokens,
  );
}

/** The free rest of a run's ceiling; never below zero. */
export function freeTokens(input: { readonly ceilingTokens: number; readonly occupiedTokens: number }): number {
  return Math.max(0, input.ceilingTokens - input.occupiedTokens);
}

/** One turn of a definition: its window plus its output cap — no single reservation of its turn is larger. */
export function turnTokensOf(limits: { readonly windowTokens: number; readonly maxOutputTokens: number }): number {
  return limits.windowTokens + limits.maxOutputTokens;
}

export type ShareDecision =
  | { readonly decision: 'granted'; readonly shareTokens: number }
  | { readonly decision: 'refused'; readonly code: 'budget_exhausted' };

/**
 * The share of a child run (DC-8): the smaller of its definition's `runTokens` and the parent's free rest; refused with
 * `budget_exhausted` when that rest is less than one turn of the child, and then no task is proposed.
 */
export function childShare(input: {
  readonly runTokens: number;
  readonly parentFreeTokens: number;
  readonly childTurnTokens: number;
}): ShareDecision {
  if (input.parentFreeTokens < input.childTurnTokens) {
    return { decision: 'refused', code: 'budget_exhausted' };
  }
  return { decision: 'granted', shareTokens: Math.min(input.runTokens, input.parentFreeTokens) };
}
