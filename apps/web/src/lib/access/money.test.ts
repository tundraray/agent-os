import { describe, expect, it } from 'vitest';
import { formatPriceUsd } from './money';

describe('formatPriceUsd (AD-11)', () => {
  it.each<[number, string]>([
    [0, '0 $'],
    [0.125, '0,125 $'],
    [3, '3 $'],
    [1000, '1 000 $'],
    [0.000000001, '0,000000001 $'],
  ])('a catalogue price %s reads %s: a comma, digit groups and no trailing zeros', (usd, expected) => {
    expect(formatPriceUsd(usd)).toBe(expected);
  });
});
