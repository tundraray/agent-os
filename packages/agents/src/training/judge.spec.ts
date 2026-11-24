import { verdictOf } from './judge';

// design-training.md KD-4: the judge sees the pair in random order; its answer maps back to the versions.
// Catches: a verdict on the wrong side when the proposed report was shown second; `equal` turned into a side.
describe('verdictOf', () => {
  it.each([
    ['first', true, 'proposed_better'],
    ['first', false, 'base_better'],
    ['second', true, 'base_better'],
    ['second', false, 'proposed_better'],
    ['equal', true, 'equal'],
  ] as const)(
    'answer %s with the proposed first = %s -> %s',
    (better, proposedFirst, verdict) => {
      expect(verdictOf({ better, reason: 'r' }, proposedFirst)).toBe(verdict);
    },
  );
});
