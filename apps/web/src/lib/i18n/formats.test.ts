import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { testFormatter } from '@/test/intl';
import { messagesOf, type FormatsTranslator } from './messages';
import type { Locale } from './pick-locale';
import {
  formatDay,
  formatDuration,
  formatListTime,
  formatMonth,
  formatQuota,
  formats,
  type Formatter,
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
    // English would show a 12-hour clock without `hourCycle: 'h23'`.
    ['list time today', 'en', (f) => formatListTime(f, TODAY, NOW), '14:32'],
    ['list time on another day', 'en', (f) => formatListTime(f, THIS_YEAR, NOW), 'Nov 12, 14:32'],
    ['day of this year', 'ru', (f) => formatDay(f, THIS_YEAR, NOW), '12 нояб.'],
    ['day of another year', 'ru', (f) => formatDay(f, LAST_YEAR, NOW), '12 нояб. 2025 г.'],
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
    ['money', 'ru', (f) => f.number(64.2, 'usd'), `64,20${NBSP}$`],
    ['whole quota', 'ru', (f) => formatQuota(f, 100), `100${NBSP}$`],
    ['quota with a fraction', 'en', (f) => formatQuota(f, 1250.5), '$1,250.50'],
    ['price with every significant digit', 'ru', (f) => f.number(0.000000001, 'usdPrice'), `0,000000001${NBSP}$`],
    ['thousand-dollar price', 'ru', (f) => f.number(1000, 'usdPrice'), `1${NBSP}000${NBSP}$`],
    ['month', 'ru', (f) => formatMonth(f, '2026-11'), 'ноябрь'],
    // West of UTC the first of the month is still the previous month's evening: the name must not follow it.
    ['month west of UTC', 'en', () => formatMonth(createFormatter({ locale: 'en', timeZone: 'America/New_York', formats }), '2026-11'), 'November'],
  ])('%s in %s', (_case, locale, render, expected) => {
    expect(render(testFormatter(locale))).toBe(expected);
  });
});

const translatorOf = (locale: Locale): FormatsTranslator =>
  createTranslator({ locale, messages: messagesOf(locale), namespace: 'formats' });

const libraryRu = createTranslator({ locale: 'ru', messages: messagesOf('ru'), namespace: 'library' });

// UC-4 / AC-04.2, foundations «Длительность» and «Слова при числах»: a count agrees with its noun in every
// form of the language, and a duration reads by the foundations steps.
describe('formats counts and durations by the interface language', () => {
  it.each<[string, Locale, (t: FormatsTranslator) => string, string]>([
    ['1 call', 'en', (t) => t('toolCallCount', { count: 1 }), '1 tool call'],
    ['2 calls', 'en', (t) => t('toolCallCount', { count: 2 }), '2 tool calls'],
    ['1 call', 'ru', (t) => t('toolCallCount', { count: 1 }), '1 вызов инструмента'],
    ['2 calls', 'ru', (t) => t('toolCallCount', { count: 2 }), '2 вызова инструментов'],
    ['5 calls', 'ru', (t) => t('toolCallCount', { count: 5 }), '5 вызовов инструментов'],
    ['21 calls', 'ru', (t) => t('toolCallCount', { count: 21 }), '21 вызов инструмента'],
    ['under a second', 'ru', (t) => formatDuration(t, 400), '<1 с'],
    ['seconds', 'ru', (t) => formatDuration(t, 42_000), '42 с'],
    ['whole minutes', 'ru', (t) => formatDuration(t, 180_000), '3 мин'],
    ['minutes and seconds', 'ru', (t) => formatDuration(t, 185_000), '3 мин 5 с'],
    ['whole hours', 'ru', (t) => formatDuration(t, 7_200_000), '2 ч'],
    ['hours and minutes', 'ru', (t) => formatDuration(t, 8_040_000), '2 ч 14 мин'],
    // «до N раз» and «до N шагов» of the deep agent and its subagents agree with the number too.
    ['up to 1 run', 'ru', () => libraryRu('team.upTo', { count: 1 }), 'до 1 раза'],
    ['up to 2 runs', 'ru', () => libraryRu('team.upTo', { count: 2 }), 'до 2 раз'],
    ['up to 5 runs', 'ru', () => libraryRu('team.upTo', { count: 5 }), 'до 5 раз'],
    ['up to 21 runs', 'ru', () => libraryRu('team.upTo', { count: 21 }), 'до 21 раза'],
    ['up to 1 step', 'ru', () => libraryRu('definition.deepAgentSummary', { model: 'M', maxTurns: 1 }), 'M · до 1 шага'],
    ['up to 2 steps', 'ru', () => libraryRu('definition.deepAgentSummary', { model: 'M', maxTurns: 2 }), 'M · до 2 шагов'],
    ['up to 21 steps', 'ru', () => libraryRu('definition.deepAgentSummary', { model: 'M', maxTurns: 21 }), 'M · до 21 шага'],
  ])('%s in %s', (_case, locale, render, expected) => {
    expect(render(translatorOf(locale))).toBe(expected);
  });
});
