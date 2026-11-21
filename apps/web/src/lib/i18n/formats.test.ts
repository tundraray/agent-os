import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { testFormatter } from '@/test/intl';
import { messagesOf } from './messages';
import type { Locale } from './pick-locale';
import {
  formatDay,
  formatDuration,
  formatListTime,
  formatMonth,
  formats,
  type Formatter,
  type FormatsTranslator,
} from './formats';

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

// Intl separates Russian digit groups and the currency sign with U+00A0.
const NBSP = String.fromCharCode(0xa0);

// UC-4 / AC-04.1, foundations «Даты, числа и деньги»: the dollar sign stands where the language puts it,
// Russian amounts take a comma, and the month is named in UTC, the zone the API counts it in.
describe('formats numbers, money and the month by the interface language', () => {
  it.each<[string, Locale, (format: Formatter) => string, string]>([
    ['number', 'en', (f) => f.number(1234.5), '1,234.5'],
    ['number', 'ru', (f) => f.number(1234.5), `1${NBSP}234,5`],
    ['money', 'en', (f) => f.number(64.2, 'usd'), '$64.20'],
    ['money', 'ru', (f) => f.number(64.2, 'usd'), `64,20${NBSP}$`],
    ['whole quota', 'en', (f) => f.number(100, 'usdQuota'), '$100'],
    ['whole quota', 'ru', (f) => f.number(100, 'usdQuota'), `100${NBSP}$`],
    ['quota with a fraction', 'ru', (f) => f.number(100.5, 'usdQuota'), `100,5${NBSP}$`],
    ['price of a fraction of a cent', 'en', (f) => f.number(0.125, 'usdPrice'), '$0.125'],
    ['price of a fraction of a cent', 'ru', (f) => f.number(0.125, 'usdPrice'), `0,125${NBSP}$`],
    ['price with every significant digit', 'ru', (f) => f.number(0.000000001, 'usdPrice'), `0,000000001${NBSP}$`],
    ['thousand-dollar price', 'ru', (f) => f.number(1000, 'usdPrice'), `1${NBSP}000${NBSP}$`],
    ['month', 'en', (f) => formatMonth(f, '2026-11'), 'November'],
    ['month', 'ru', (f) => formatMonth(f, '2026-11'), 'ноябрь'],
    // West of UTC the first of the month is still the previous month's evening: the name must not follow it.
    ['month west of UTC', 'en', () => formatMonth(createFormatter({ locale: 'en', timeZone: 'America/New_York', formats }), '2026-11'), 'November'],
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
