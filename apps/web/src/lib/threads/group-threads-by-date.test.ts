import { describe, expect, it } from 'vitest';
import {
  entryActivityAt,
  groupThreadsByDate,
  type DateGroupKey,
  type ThreadListEntry,
} from './group-threads-by-date';

/** Local wall-clock time in the test zone (Europe/Berlin, set in vitest.config.ts). */
function local(year: number, month: number, day: number, hours = 12, minutes = 0): Date {
  return new Date(year, month - 1, day, hours, minutes);
}

function entry(id: string, activityAt: Date | number): ThreadListEntry {
  return {
    id,
    remoteId: id,
    title: `Беседа ${id}`,
    activityAt: typeof activityAt === 'number' ? activityAt : activityAt.getTime(),
  };
}

function keyOf(activityAt: Date, now: Date): DateGroupKey | undefined {
  return groupThreadsByDate([entry('x', activityAt)], now)[0]?.key;
}

function shape(entries: readonly ThreadListEntry[], now: Date): Array<[string, string[]]> {
  return groupThreadsByDate(entries, now).map((group) => [group.label, group.entries.map((e) => e.id)]);
}

describe('groupThreadsByDate', () => {
  it('runs in Europe/Berlin, whose clocks change on 2026-03-29', () => {
    expect(new Date(2026, 2, 28).getTimezoneOffset()).not.toBe(new Date(2026, 2, 30).getTimezoneOffset());
  });

  it('AC-01.1: today, yesterday, 5 and 40 days ago form exactly four labelled groups in order, no empty ones', () => {
    const now = local(2026, 10, 30, 15);
    const entries = [
      entry('d40', local(2026, 9, 20, 9)),
      entry('d0', local(2026, 10, 30, 8)),
      entry('d5', local(2026, 10, 25, 18)),
      entry('d1', local(2026, 10, 29, 23)),
    ];

    expect(shape(entries, now)).toEqual([
      ['Сегодня', ['d0']],
      ['Вчера', ['d1']],
      ['Предыдущие 7 дней', ['d5']],
      ['Старше', ['d40']],
    ]);
  });

  it.each([
    { days: -1, expected: 'today' },
    { days: 0, expected: 'today' },
    { days: 1, expected: 'yesterday' },
    { days: 2, expected: 'previous7' },
    { days: 7, expected: 'previous7' },
    { days: 8, expected: 'previous30' },
    { days: 30, expected: 'previous30' },
    { days: 31, expected: 'older' },
  ] as const)('a thread $days calendar day(s) old falls into $expected', ({ days, expected }) => {
    const now = local(2026, 6, 15, 10);
    expect(keyOf(local(2026, 6, 15 - days, 22), now)).toBe(expected);
  });

  it.each([
    { name: '23-hour day: 2026-03-28 23:30 seen at 2026-03-29 12:00', activity: local(2026, 3, 28, 23, 30), now: local(2026, 3, 29, 12), expected: 'yesterday' },
    { name: '23-hour day: 2026-03-29 00:30 seen at 2026-03-29 12:00', activity: local(2026, 3, 29, 0, 30), now: local(2026, 3, 29, 12), expected: 'today' },
    { name: '23-hour day: 2026-03-29 12:00 seen at 2026-03-30 12:00', activity: local(2026, 3, 29, 12), now: local(2026, 3, 30, 12), expected: 'yesterday' },
    { name: 'spring gap inside 8 days: 2026-03-24 seen at 2026-04-01', activity: local(2026, 3, 24, 12), now: local(2026, 4, 1, 12), expected: 'previous30' },
    { name: '25-hour day: 2026-10-24 23:30 seen at 2026-10-25 23:30', activity: local(2026, 10, 24, 23, 30), now: local(2026, 10, 25, 23, 30), expected: 'yesterday' },
    { name: '25-hour day: 2026-10-18 12:00 seen at 2026-10-25 23:30 (boundary 7)', activity: local(2026, 10, 18, 12), now: local(2026, 10, 25, 23, 30), expected: 'previous7' },
    { name: '25-hour day: 2026-10-25 23:30 seen at 2026-10-26 00:10', activity: local(2026, 10, 25, 23, 30), now: local(2026, 10, 26, 0, 10), expected: 'yesterday' },
  ] as const)('DST in Europe/Berlin — $name → $expected', ({ activity, now, expected }) => {
    expect(keyOf(activity, now)).toBe(expected);
  });

  it('keeps the original order of threads with equal activity time', () => {
    const now = local(2026, 10, 30, 15);
    const same = local(2026, 10, 30, 10);
    const entries = [entry('first', same), entry('second', same), entry('third', same), entry('newer', local(2026, 10, 30, 11))];

    expect(shape(entries, now)).toEqual([['Сегодня', ['newer', 'first', 'second', 'third']]]);
  });

  it('AC-19.1: concatenating a second page keeps group order monotonic — no "Сегодня" after "Вчера"', () => {
    const now = local(2026, 10, 30, 15);
    const pageOne = [entry('p1-today', local(2026, 10, 30, 9)), entry('p1-yesterday', local(2026, 10, 29, 9))];
    const pageTwo = [entry('p2-today', local(2026, 10, 30, 8)), entry('p2-old', local(2026, 8, 1, 9))];

    expect(shape([...pageOne, ...pageTwo], now)).toEqual([
      ['Сегодня', ['p1-today', 'p2-today']],
      ['Вчера', ['p1-yesterday']],
      ['Старше', ['p2-old']],
    ]);
  });

  describe('ordering', () => {
    const now = local(2026, 10, 30, 15);
    const lastMessageAt = { a: local(2026, 10, 30, 9), b: local(2026, 10, 30, 11), c: local(2026, 10, 27, 10) };
    const lifted: Partial<Record<keyof typeof lastMessageAt, number>> = { c: now.getTime() - 60_000 };

    it.each<{ readonly name: string; readonly entries: readonly ThreadListEntry[]; readonly expected: Array<[string, string[]]> }>([
      {
        name: 'an empty list yields no groups',
        entries: [],
        expected: [],
      },
      {
        name: 'sorts by activity time descending inside and across groups; a locally lifted thread moves to the top',
        entries: (['a', 'b', 'c'] as const).map((id) =>
          entry(id, entryActivityAt({ lastMessageAt: lastMessageAt[id], activityAt: lifted[id] }, now)),
        ),
        expected: [['Сегодня', ['c', 'b', 'a']]],
      },
      {
        name: 'a thread without sort keys lands at the top of "Сегодня" instead of disappearing',
        entries: [
          entry('known', local(2026, 10, 30, 9)),
          entry('fresh', entryActivityAt({ lastMessageAt: undefined, activityAt: undefined }, now)),
        ],
        expected: [['Сегодня', ['fresh', 'known']]],
      },
    ])('$name', ({ entries, expected }) => {
      expect(shape(entries, now)).toEqual(expected);
    });
  });
});

describe('entryActivityAt', () => {
  const now = local(2026, 10, 30, 15);

  it.each([
    { name: 'server time only', input: { lastMessageAt: local(2026, 10, 29, 9), activityAt: undefined }, expected: local(2026, 10, 29, 9).getTime() },
    { name: 'local lift later than server time', input: { lastMessageAt: local(2026, 10, 29, 9), activityAt: local(2026, 10, 30, 14).getTime() }, expected: local(2026, 10, 30, 14).getTime() },
    { name: 'server time later than local lift', input: { lastMessageAt: local(2026, 10, 30, 14), activityAt: local(2026, 10, 29, 9).getTime() }, expected: local(2026, 10, 30, 14).getTime() },
    { name: 'local lift only', input: { lastMessageAt: undefined, activityAt: local(2026, 10, 30, 14).getTime() }, expected: local(2026, 10, 30, 14).getTime() },
    { name: 'neither key → now', input: { lastMessageAt: undefined, activityAt: undefined }, expected: now.getTime() },
  ])('$name', ({ input, expected }) => {
    expect(entryActivityAt(input, now)).toBe(expected);
  });
});
