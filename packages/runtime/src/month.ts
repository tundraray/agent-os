/**
 * The month rule of spend (AC-21.4, DC-9): a month is the UTC calendar month `YYYY-MM`. The access
 * check, «Мой доступ» and `GET /spend` all take the month here.
 */

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The UTC calendar month `YYYY-MM` that holds `time`. */
export function monthOf(time: Date): string {
  return time.toISOString().slice(0, 7);
}

/** The window of the month `YYYY-MM`: `[start of the month UTC, start of the next)`. */
export function monthWindowUtc(month: string): { from: Date; to: Date } {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) {
    throw new Error(`Invalid month "${month}": expected YYYY-MM`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)),
    to: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}
