import { decideReserve, type ReserveCounters } from './reserve-rule.js';

// Invariant 6 and «Как резерв решает: ждать или отказать» (design-engine.md, KD-5, DC-5, AC-10.2): the reserve is
// refused only when the spent tokens and this reserve exceed the budget; the task ceiling refuses before any wait; the
// open reserves of other calls alone make it `busy`; a reserve exactly equal to what is left fits.
// Defects caught: a fourth worker refused because of the reserves of three others; a call that can never fit made to
// wait; a call that never fits its task made to wait; an exact fit refused or held.

const BASE: ReserveCounters = {
  tokenBudget: 200_000,
  tokensSpent: 20_000,
  tokensReserved: 0,
  taskTokensHeld: 0,
  taskMaxTokens: 225_600,
  reservedTokens: 51_200,
};

describe('decideReserve', () => {
  it.each<[string, Partial<ReserveCounters>, ReturnType<typeof decideReserve>]>([
    ['nothing else open: reserved', {}, { decision: 'reserved' }],
    ['three open reserves of others, the fourth does not fit with them: busy', { tokensReserved: 153_600 }, { decision: 'busy' }],
    ['open reserves leave exactly this reserve: reserved', { tokensReserved: 128_800 }, { decision: 'reserved' }],
    ['open reserves leave one token less than this reserve: busy', { tokensReserved: 128_801 }, { decision: 'busy' }],
    [
      'the spent tokens and this reserve exceed the budget: refused, even with no open reserve',
      { tokensSpent: 148_801 },
      { decision: 'refused', code: 'investigation_tokens_exhausted' },
    ],
    [
      'the spent tokens and this reserve exceed the budget while others are open: refused, not busy',
      { tokensSpent: 160_000, tokensReserved: 30_000 },
      { decision: 'refused', code: 'investigation_tokens_exhausted' },
    ],
    ['the spent tokens and this reserve are exactly the budget: reserved', { tokensSpent: 148_800 }, { decision: 'reserved' }],
    [
      'the task ceiling is passed while others are open: refused at once, not busy',
      { tokensReserved: 153_600, taskTokensHeld: 174_401 },
      { decision: 'refused', code: 'task_tokens_exhausted' },
    ],
    ['the task ceiling is met exactly: reserved', { taskTokensHeld: 174_400 }, { decision: 'reserved' }],
    [
      'both the budget and the task ceiling are passed: the budget answers first',
      { tokensSpent: 160_000, taskTokensHeld: 200_000 },
      { decision: 'refused', code: 'investigation_tokens_exhausted' },
    ],
  ])('%s', (_case, counters, expected) => {
    expect(decideReserve({ ...BASE, ...counters })).toEqual(expected);
  });
});
