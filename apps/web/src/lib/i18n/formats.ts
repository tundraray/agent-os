import type { createFormatter, Formats, useTranslations } from 'next-intl';

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

/** The `formats` messages: pure functions receive them as a parameter, components take `useTranslations('formats')`. */
export type FormatsTranslator = ReturnType<typeof useTranslations<'formats'>>;

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

/** A duration by the foundations steps: «<1 с», «42 с», «3 мин 5 с», «2 ч 14 мин». */
export function formatDuration(t: FormatsTranslator, ms: number): string {
  if (ms < 1000) return t('duration.underSecond');
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('duration.seconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? t('duration.minutes', { minutes }) : t('duration.minutesSeconds', { minutes, seconds: rest });
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t('duration.hours', { hours }) : t('duration.hoursMinutes', { hours, minutes: rest });
}
