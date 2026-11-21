import type { createFormatter, Formats } from 'next-intl';
import type { FormatsTranslator } from './messages';

/**
 * The shared date and number formats the interface-language provider receives (design-web.md, «Форматы»;
 * foundations «Даты, числа и деньги»). The month is always a word and the clock 24-hour in both languages;
 * the currency is always the dollar, its sign placed where the language puts it.
 */
export const formats = {
  dateTime: {
    time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    day: { day: 'numeric', month: 'short' },
    dayOtherYear: { day: 'numeric', month: 'short', year: 'numeric' },
    dayTime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    // The API counts spend and quotas by the UTC month, and the server renders this name too (design Risks,
    // «Часовой пояс при серверной отрисовке»): in UTC the server and the browser name the same month.
    month: { month: 'long', timeZone: 'UTC' },
  },
  number: {
    /** Spend and remaining: always cents — «64,20 $», “$64.20”. */
    usd: { style: 'currency', currency: 'USD' },
    /** A whole quota without cents — «100 $»; `formatQuota` picks it. */
    usdQuota: { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 },
    /** A catalogue price per million tokens: every significant digit up to nine decimals — «0,125 $». */
    usdPrice: { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 9 },
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

/**
 * A quota: a whole amount without cents — «100 $», “$100”; any other with cents, as spend reads beside it —
 * «1 250,50 $», “$1,250.50”. Intl has no “0 or 2 decimals”, so the amount in cents decides.
 */
export function formatQuota(format: Formatter, usd: number): string {
  return format.number(usd, Math.round(usd * 100) % 100 === 0 ? 'usdQuota' : 'usd');
}

/** The UTC month `YYYY-MM` of a moment: the month the API counts spend and quotas in. */
export function utcMonthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** `2026-11` → «ноябрь» / “November”, for «… за {месяц}». */
export function formatMonth(format: Formatter, month: string): string {
  return format.dateTime(new Date(`${month}-01T00:00:00Z`), 'month');
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
