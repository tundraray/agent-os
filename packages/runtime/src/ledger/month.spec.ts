import { monthOf } from './month';

// AC-21.4, DC-9: one month rule for the access check, «Мой доступ» and `GET /spend` - the UTC
// calendar month. Catches a month boundary taken in the local time zone.
describe('monthOf is the UTC calendar month', () => {
  it.each([
    ['the last millisecond of October', '2026-10-31T23:59:59.999Z', '2026-10'],
    ['the first instant of November', '2026-11-01T00:00:00Z', '2026-11'],
    ['a local November evening that is December in UTC', '2026-11-30T23:30:00-01:00', '2026-12'],
  ])('%s', (_, time, month) => {
    expect(monthOf(new Date(time))).toBe(month);
  });
});
