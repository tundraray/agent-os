const MONTH_NAMES = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
] as const;

/** U+202F, the digit-group separator agent-platform MC-2 asks for. */
const NARROW_NO_BREAK_SPACE = ' ';

/** The UTC month `YYYY-MM` of a moment: the month the API counts spend and quotas in. */
export function utcMonthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** `2026-11` → «ноябрь», for «… за {месяц}». */
export function monthName(month: string): string {
  return MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
}

const groupDigits = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_NO_BREAK_SPACE);

/** Spend and remaining (MC-2): two decimals after a comma, digit groups split by U+202F — `3,10 $`, `0,00 $`. */
export function formatUsd(usd: number): string {
  const [whole = '0', cents = '00'] = usd.toFixed(2).split('.');
  return `${groupDigits(whole)},${cents} $`;
}

/** A quota «без лишних нулей» (enterprise-access UXRD, Content): `100 $`, `100,5 $`. */
export function formatQuotaUsd(usd: number): string {
  const [whole = '0', cents = ''] = usd.toFixed(2).replace(/\.?0+$/, '').split('.');
  return `${groupDigits(whole)}${cents === '' ? '' : `,${cents}`} $`;
}
