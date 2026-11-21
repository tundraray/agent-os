import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { testFormatter } from '@/test/intl';
import { messagesOf } from './messages';
import type { Locale } from './pick-locale';
import { formatDay, formatDuration, formatListTime, type Formatter, type FormatsTranslator } from './formats';

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

const translatorOf = (locale: Locale): FormatsTranslator =>
  createTranslator({ locale, messages: messagesOf(locale), namespace: 'formats' });

// UC-4 / AC-04.2, foundations «Длительность» and «Слова при числах»: a count agrees with its noun in every
// form of the language, and a duration reads by the foundations steps.
describe('formats counts and durations by the interface language', () => {
  it.each<[string, Locale, (t: FormatsTranslator) => string, string]>([
    ['1 call', 'en', (t) => t('toolCallCount', { count: 1 }), '1 tool call'],
    ['2 calls', 'en', (t) => t('toolCallCount', { count: 2 }), '2 tool calls'],
    ['21 calls', 'en', (t) => t('toolCallCount', { count: 21 }), '21 tool calls'],
    ['1 call', 'ru', (t) => t('toolCallCount', { count: 1 }), '1 вызов инструмента'],
    ['2 calls', 'ru', (t) => t('toolCallCount', { count: 2 }), '2 вызова инструментов'],
    ['5 calls', 'ru', (t) => t('toolCallCount', { count: 5 }), '5 вызовов инструментов'],
    ['21 calls', 'ru', (t) => t('toolCallCount', { count: 21 }), '21 вызов инструмента'],
    ['under a second', 'en', (t) => formatDuration(t, 400), '<1 s'],
    ['seconds', 'en', (t) => formatDuration(t, 42_000), '42 s'],
    ['minutes and seconds', 'en', (t) => formatDuration(t, 185_000), '3 min 5 s'],
    ['hours and minutes', 'en', (t) => formatDuration(t, 8_040_000), '2 h 14 min'],
    ['under a second', 'ru', (t) => formatDuration(t, 400), '<1 с'],
    ['seconds', 'ru', (t) => formatDuration(t, 42_000), '42 с'],
    ['whole minutes', 'ru', (t) => formatDuration(t, 180_000), '3 мин'],
    ['minutes and seconds', 'ru', (t) => formatDuration(t, 185_000), '3 мин 5 с'],
    ['whole hours', 'ru', (t) => formatDuration(t, 7_200_000), '2 ч'],
    ['hours and minutes', 'ru', (t) => formatDuration(t, 8_040_000), '2 ч 14 мин'],
  ])('%s in %s', (_case, locale, render, expected) => {
    expect(render(translatorOf(locale))).toBe(expected);
  });
});
