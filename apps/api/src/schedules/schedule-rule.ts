import type { ScheduleRule } from '@agent-os/contracts';

/**
 * The due-time rule of schedules (design-schedules.md, KD-7): terms of a rule in its IANA time zone, counted
 * with the `Temporal` built into Node 26. A local time the day does not have (clocks moved forward) becomes
 * the first time that exists after it; a repeated one (clocks moved back) is taken the first time.
 */

/** A schedule as the rule reads it. */
export interface RuleInput {
  readonly rule: ScheduleRule;
  readonly timeZone: string;
  /** The moment `every_hours` terms count from: the rule's creation or last change. */
  readonly ruleSetAt: Date;
}

const HOUR_MS = 3_600_000;
/** Days looked at for the next `daily` or `weekdays` term: a week and the day it started on. */
const WEEK_SPAN_DAYS = 8;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7] as const;

/** Whether the time zone is an IANA name `Temporal` knows. */
function knownTimeZone(timeZone: string): boolean {
  try {
    new Temporal.ZonedDateTime(0n, timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The local date, or `undefined` for one the calendar does not have. */
function plainDate(date: string): Temporal.PlainDate | undefined {
  try {
    return Temporal.PlainDate.from(date, { overflow: 'reject' });
  } catch {
    return undefined;
  }
}

/** The instant of a local date and time: a skipped time → the first existing after it, a repeated one → the first. */
function localInstant(
  date: Temporal.PlainDate,
  time: string,
  timeZone: string,
): Date {
  const local = date.toPlainDateTime(Temporal.PlainTime.from(time));
  const earlier = local.toZonedDateTime(timeZone, {
    disambiguation: 'earlier',
  });
  if (earlier.toPlainDateTime().equals(local))
    return new Date(earlier.epochMilliseconds);
  // The time falls in a gap: the first existing time after it is the moment the clocks moved.
  const later = local.toZonedDateTime(timeZone, { disambiguation: 'later' });
  const transition = later.getTimeZoneTransition('previous') ?? later;
  return new Date(transition.epochMilliseconds);
}

/** The first term of `days` at `time` strictly after `moment`. */
function nextOnDays(
  days: readonly number[],
  time: string,
  timeZone: string,
  moment: Date,
): Date | null {
  const start = Temporal.Instant.fromEpochMilliseconds(moment.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  for (let offset = 0; offset < WEEK_SPAN_DAYS; offset += 1) {
    const date = start.add({ days: offset });
    if (!days.includes(date.dayOfWeek)) continue;
    const term = localInstant(date, time, timeZone);
    if (term.getTime() > moment.getTime()) return term;
  }
  return null;
}

/**
 * Why the rule cannot be a schedule's, or `null`: an unknown time zone, a date the calendar lacks, or a `once`
 * term not after `now` (design-schedules.md, DC-2). The shape of the rule is the contract schema's.
 */
export function ruleProblem(
  rule: ScheduleRule,
  timeZone: string,
  now: Date,
): string | null {
  if (!knownTimeZone(timeZone)) return 'timeZone: unknown time zone';
  if (rule.kind !== 'once') return null;
  const date = plainDate(rule.date);
  if (date === undefined) return 'rule.date: no such date';
  return localInstant(date, rule.time, timeZone).getTime() > now.getTime()
    ? null
    : 'rule: the time is in the past';
}

/** The first term of the schedule strictly after `moment`; `null` when it has none (`once` past its term). */
export function nextTermAfter(
  { rule, timeZone, ruleSetAt }: RuleInput,
  moment: Date,
): Date | null {
  switch (rule.kind) {
    case 'once': {
      const date = plainDate(rule.date);
      if (date === undefined) return null;
      const term = localInstant(date, rule.time, timeZone);
      return term.getTime() > moment.getTime() ? term : null;
    }
    case 'daily':
      return nextOnDays(EVERY_DAY, rule.time, timeZone, moment);
    case 'weekdays':
      return nextOnDays(rule.days, rule.time, timeZone, moment);
    case 'every_hours': {
      const period = rule.hours * HOUR_MS;
      const since = moment.getTime() - ruleSetAt.getTime();
      const count = since < 0 ? 1 : Math.floor(since / period) + 1;
      return new Date(ruleSetAt.getTime() + count * period);
    }
  }
}

/**
 * The terms from `expected` through `now`, earliest first: `expected` itself and every later one not after
 * `now`. All but the last are the terms the server missed (FR-06); `[]` when `expected` is still ahead.
 */
export function termsThrough(
  input: RuleInput,
  expected: Date,
  now: Date,
): Date[] {
  const terms: Date[] = [];
  let term: Date | null = expected;
  while (term !== null && term.getTime() <= now.getTime()) {
    terms.push(term);
    term = nextTermAfter(input, term);
  }
  return terms;
}
