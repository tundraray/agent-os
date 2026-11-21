import { describe, expect, it } from 'vitest';
import { testFormatter } from '@/test/intl';
import type { Locale } from './pick-locale';
import { formatDay, formatListTime, type Formatter } from './formats';

// Moments in the test zone (Europe/Berlin, UTC+1 in November).
const NOW = new Date('2026-11-21T15:00:00Z');
const TODAY = '2026-11-21T13:32:00Z';
const THIS_YEAR = '2026-11-12T13:32:00Z';
const LAST_YEAR = '2025-11-12T13:32:00Z';

// UC-4 / AC-04.1, foundations «Даты, числа и деньги»: a date never reads in digits only, the clock is 24-hour,
// and each language keeps its own day-month order.
describe('formats moments by the interface language', () => {
  it.each<[string, Locale, (format: Formatter) => string, string]>([
    ['list time today', 'en', (f) => formatListTime(f, TODAY, NOW), '14:32'],
    ['list time today', 'ru', (f) => formatListTime(f, TODAY, NOW), '14:32'],
    ['list time on another day', 'en', (f) => formatListTime(f, THIS_YEAR, NOW), 'Nov 12, 14:32'],
    ['list time on another day', 'ru', (f) => formatListTime(f, THIS_YEAR, NOW), '12 нояб., 14:32'],
    ['day of this year', 'en', (f) => formatDay(f, THIS_YEAR, NOW), 'Nov 12'],
    ['day of this year', 'ru', (f) => formatDay(f, THIS_YEAR, NOW), '12 нояб.'],
    ['day of another year', 'en', (f) => formatDay(f, LAST_YEAR, NOW), 'Nov 12, 2025'],
    ['day of another year', 'ru', (f) => formatDay(f, LAST_YEAR, NOW), '12 нояб. 2025 г.'],
    ['day with time', 'en', (f) => f.dateTime(new Date(THIS_YEAR), 'dayTime'), 'Nov 12, 14:32'],
    ['day with time', 'ru', (f) => f.dateTime(new Date(THIS_YEAR), 'dayTime'), '12 нояб., 14:32'],
  ])('%s in %s', (_case, locale, render, expected) => {
    expect(render(testFormatter(locale))).toBe(expected);
  });
});
