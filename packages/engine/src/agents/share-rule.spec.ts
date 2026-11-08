import { type ChildHolding, childShare, freeTokens, occupiedTokens, type ShareDecision } from './share-rule.js';

// DC-8, DC-9 (the rule), DC-10, KD-4, invariant 6: a child's share is the smaller of its `runTokens` and the parent's free
// rest, refused with `budget_exhausted` below one turn of the child; the parent occupies a child's whole share while
// the child's subtree has a task in work — a failed child with a live grandchild too — and the subtree's actual spending
// once it has none. The numbers follow the design's example: a budget of 300 000 and workers of 80 000.
// Defects caught: a share larger than the parent's rest; a share granted below one turn; a finished child's share kept
// whole (its rest never returns); a live subtree's share returned early because its own run already ended.
// UC-5 (a second call paid by a returned rest) is a composition of these rows; INT-4 B4 proves it on the real ledger.

const inWork = (shareTokens: number, subtreeSpentTokens: number): ChildHolding => ({
  shareTokens,
  subtreeInWork: true,
  subtreeSpentTokens,
});
const finished = (shareTokens: number, subtreeSpentTokens: number): ChildHolding => ({
  shareTokens,
  subtreeInWork: false,
  subtreeSpentTokens,
});

interface Row {
  readonly ceilingTokens: number;
  readonly ownTokens: number;
  readonly children: readonly ChildHolding[];
  /** The next child's definition: its `runTokens` and one turn. */
  readonly runTokens: number;
  readonly childTurnTokens: number;
}

describe('доля дочернего и занятое родителя', () => {
  it.each<[string, Row, number, ShareDecision]>([
    [
      'two workers in work occupy their whole shares; a third gets its runTokens',
      { ceilingTokens: 300_000, ownTokens: 5_000, children: [inWork(80_000, 10_000), inWork(80_000, 20_000)], runTokens: 80_000, childTurnTokens: 50_000 },
      165_000,
      { decision: 'granted', shareTokens: 80_000 },
    ],
    [
      'a worker whose subtree finished occupies only what it spent; the rest is free again',
      { ceilingTokens: 300_000, ownTokens: 5_000, children: [finished(80_000, 30_000), inWork(80_000, 20_000)], runTokens: 80_000, childTurnTokens: 50_000 },
      115_000,
      { decision: 'granted', shareTokens: 80_000 },
    ],
    [
      'a failed child with a grandchild still in work occupies its whole share',
      { ceilingTokens: 100_000, ownTokens: 0, children: [inWork(80_000, 5_000)], runTokens: 30_000, childTurnTokens: 10_000 },
      80_000,
      { decision: 'granted', shareTokens: 20_000 },
    ],
    [
      'a rest smaller than runTokens: the share is the rest',
      { ceilingTokens: 100_000, ownTokens: 5_000, children: [inWork(80_000, 0)], runTokens: 80_000, childTurnTokens: 10_000 },
      85_000,
      { decision: 'granted', shareTokens: 15_000 },
    ],
    [
      'a rest of exactly one turn of the child: granted',
      { ceilingTokens: 100_000, ownTokens: 10_000, children: [inWork(80_000, 0)], runTokens: 80_000, childTurnTokens: 10_000 },
      90_000,
      { decision: 'granted', shareTokens: 10_000 },
    ],
    [
      'a rest one token short of a turn of the child: budget_exhausted',
      { ceilingTokens: 100_000, ownTokens: 10_001, children: [inWork(80_000, 0)], runTokens: 80_000, childTurnTokens: 10_000 },
      90_001,
      { decision: 'refused', code: 'budget_exhausted' },
    ],
    [
      'nothing free at all: budget_exhausted',
      { ceilingTokens: 100_000, ownTokens: 20_000, children: [inWork(80_000, 0)], runTokens: 80_000, childTurnTokens: 1 },
      100_000,
      { decision: 'refused', code: 'budget_exhausted' },
    ],
  ])('%s', (_case, row, occupied, decision) => {
    const taken = occupiedTokens({ ownTokens: row.ownTokens, children: row.children });

    expect(taken).toBe(occupied);
    expect(
      childShare({
        runTokens: row.runTokens,
        parentFreeTokens: freeTokens({ ceilingTokens: row.ceilingTokens, occupiedTokens: taken }),
        childTurnTokens: row.childTurnTokens,
      }),
    ).toEqual(decision);
  });
});
