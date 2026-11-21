import type { createFormatter, Formats } from 'next-intl';

/**
 * The shared date formats the interface-language provider receives (design-web.md, «Форматы»;
 * foundations «Даты, числа и деньги»). The month is always a word and the clock 24-hour in both languages.
 */
export const formats = {
  dateTime: {
    time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    day: { day: 'numeric', month: 'short' },
    dayOtherYear: { day: 'numeric', month: 'short', year: 'numeric' },
    dayTime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  },
} as const satisfies Formats;

/** The formatter `useFormatter()` returns; pure functions receive it as a parameter. */
export type Formatter = ReturnType<typeof createFormatter>;

type Moment = string | Date;

const toDate = (at: Moment): Date => (typeof at === 'string' ? new Date(at) : at);

// Compared in the formatter's own time zone, so «today» is the viewer's today wherever this runs.
const sameDay = (format: Formatter, a: Date, b: Date): boolean =>
  format.dateTime(a, 'dayOtherYear') === format.dateTime(b, 'dayOtherYear');

const sameYear = (format: Formatter, a: Date, b: Date): boolean =>
  format.dateTime(a, { year: 'numeric' }) === format.dateTime(b, { year: 'numeric' });

/** The day of a moment: «12 нояб.» / “Nov 12”, with the year when it is not this year's. */
export function formatDay(format: Formatter, at: Moment, now: Date = new Date()): string {
  const date = toDate(at);
  return format.dateTime(date, sameYear(format, date, now) ? 'day' : 'dayOtherYear');
}

/** The time in lists and the feed: «14:32» for today, otherwise «12 нояб., 14:32». */
export function formatListTime(format: Formatter, at: Moment, now: Date = new Date()): string {
  const date = toDate(at);
  return format.dateTime(date, sameDay(format, date, now) ? 'time' : 'dayTime');
}
