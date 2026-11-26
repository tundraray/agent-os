import { describe, expect, it } from 'vitest';
import { parseTime } from './schedule-rule-field';

// The time is typed as text in every browser locale; the API takes only a 24-hour `HH:MM`.
describe('parseTime', () => {
  it.each([
    ['09:00', '09:00'],
    ['9:05', '09:05'],
    ['0905', '09:05'],
    ['905', '09:05'],
    [' 23:59 ', '23:59'],
    ['00:00', '00:00'],
    ['24:00', null],
    ['12:60', null],
    ['9', null],
    ['09:00 AM', null],
    ['', null],
  ])('reads %j as %j', (typed, expected) => {
    expect(parseTime(typed)).toBe(expected);
  });
});
