import type { ScheduleRule } from '@agent-os/contracts';
import { nextTermAfter, ruleProblem, termsThrough } from './schedule-rule';

// The due-time rule (design-schedules.md, KD-7, DC-2): the four kinds, the week, a time zone whose clocks move,
// the terms missed while the server was down, and rules a schedule may not have.

const MOSCOW = 'Europe/Moscow'; // UTC+3, no clock changes
const BERLIN = 'Europe/Berlin'; // 2026-03-29 02:00 → 03:00, 2026-10-25 03:00 → 02:00

const at = (iso: string) => new Date(iso);
const RULE_SET_AT = at('2026-11-25T10:00:00Z');

function next(rule: ScheduleRule, timeZone: string, moment: string) {
  return (
    nextTermAfter(
      { rule, timeZone, ruleSetAt: RULE_SET_AT },
      at(moment),
    )?.toISOString() ?? null
  );
}

function missed(
  rule: ScheduleRule,
  timeZone: string,
  expected: string,
  now: string,
) {
  return termsThrough(
    { rule, timeZone, ruleSetAt: RULE_SET_AT },
    at(expected),
    at(now),
  ).map((term) => term.toISOString());
}

const daily9: ScheduleRule = { kind: 'daily', time: '09:00' };

describe('the due-time rule', () => {
  it.each<[string, () => unknown, unknown]>([
    [
      'once: its term while ahead',
      () =>
        next(
          { kind: 'once', date: '2026-12-01', time: '09:00' },
          MOSCOW,
          '2026-11-25T00:00:00Z',
        ),
      '2026-12-01T06:00:00.000Z',
    ],
    [
      'once: none after its term',
      () =>
        next(
          { kind: 'once', date: '2026-12-01', time: '09:00' },
          MOSCOW,
          '2026-12-01T06:00:00Z',
        ),
      null,
    ],
    [
      'daily: today before the time',
      () => next(daily9, MOSCOW, '2026-11-25T05:00:00Z'),
      '2026-11-25T06:00:00.000Z',
    ],
    [
      'daily: tomorrow at the term itself',
      () => next(daily9, MOSCOW, '2026-11-25T06:00:00Z'),
      '2026-11-26T06:00:00.000Z',
    ],
    [
      'weekdays: Monday from a Wednesday',
      () =>
        next(
          { kind: 'weekdays', days: [1], time: '09:00' },
          MOSCOW,
          '2026-11-25T07:00:00Z',
        ),
      '2026-11-30T06:00:00.000Z',
    ],
    [
      'weekdays: Friday after Monday’s time',
      () =>
        next(
          { kind: 'weekdays', days: [1, 5], time: '09:00' },
          MOSCOW,
          '2026-11-30T07:00:00Z',
        ),
      '2026-12-04T06:00:00.000Z',
    ],
    [
      'weekdays: the same day a week later',
      () =>
        next(
          { kind: 'weekdays', days: [3], time: '09:00' },
          MOSCOW,
          '2026-11-25T07:00:00Z',
        ),
      '2026-12-02T06:00:00.000Z',
    ],
    [
      'clocks forward: a skipped time becomes the first existing one (03:00 CEST)',
      () =>
        next({ kind: 'daily', time: '02:30' }, BERLIN, '2026-03-28T12:00:00Z'),
      '2026-03-29T01:00:00.000Z',
    ],
    [
      'clocks back: a repeated time is taken the first time (02:30 CEST)',
      () =>
        next({ kind: 'daily', time: '02:30' }, BERLIN, '2026-10-24T12:00:00Z'),
      '2026-10-25T00:30:00.000Z',
    ],
    [
      'every_hours: the first term after the rule was set',
      () =>
        next({ kind: 'every_hours', hours: 3 }, MOSCOW, '2026-11-25T10:00:00Z'),
      '2026-11-25T13:00:00.000Z',
    ],
    [
      'every_hours: counted from the rule, not from now',
      () =>
        next({ kind: 'every_hours', hours: 3 }, MOSCOW, '2026-11-25T14:30:00Z'),
      '2026-11-25T16:00:00.000Z',
    ],
    [
      'every_hours: the next one at the term itself',
      () =>
        next({ kind: 'every_hours', hours: 3 }, MOSCOW, '2026-11-25T16:00:00Z'),
      '2026-11-25T19:00:00.000Z',
    ],
    [
      'missed terms: the expected one and every one up to now',
      () =>
        missed(daily9, MOSCOW, '2026-11-23T06:00:00Z', '2026-11-25T07:00:00Z'),
      [
        '2026-11-23T06:00:00.000Z',
        '2026-11-24T06:00:00.000Z',
        '2026-11-25T06:00:00.000Z',
      ],
    ],
    [
      'missed terms: none while the expected one is ahead',
      () =>
        missed(daily9, MOSCOW, '2026-11-26T06:00:00Z', '2026-11-25T07:00:00Z'),
      [],
    ],
    [
      'missed terms: once gives only its own',
      () =>
        missed(
          { kind: 'once', date: '2026-12-01', time: '09:00' },
          MOSCOW,
          '2026-12-01T06:00:00Z',
          '2026-12-05T00:00:00Z',
        ),
      ['2026-12-01T06:00:00.000Z'],
    ],
    [
      'invalid: unknown time zone',
      () =>
        ruleProblem(daily9, 'Mars/Olympus', at('2026-11-25T00:00:00Z')) !==
        null,
      true,
    ],
    [
      'invalid: once in the past',
      () =>
        ruleProblem(
          { kind: 'once', date: '2026-11-24', time: '09:00' },
          MOSCOW,
          at('2026-11-25T00:00:00Z'),
        ) !== null,
      true,
    ],
    [
      'invalid: a date the calendar lacks',
      () =>
        ruleProblem(
          { kind: 'once', date: '2027-02-30', time: '09:00' },
          MOSCOW,
          at('2026-11-25T00:00:00Z'),
        ) !== null,
      true,
    ],
    [
      'valid: once ahead',
      () =>
        ruleProblem(
          { kind: 'once', date: '2026-12-01', time: '09:00' },
          MOSCOW,
          at('2026-11-25T00:00:00Z'),
        ),
      null,
    ],
    [
      'valid: daily in a known zone',
      () => ruleProblem(daily9, BERLIN, at('2026-11-25T00:00:00Z')),
      null,
    ],
  ])('%s', (_name, actual, expected) => {
    expect(actual()).toEqual(expected);
  });
});
