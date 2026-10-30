import { describe, expect, it } from 'vitest';
import { pluralRu } from './plural-ru';

const TOOL_CALL_FORMS = ['вызов инструмента', 'вызова инструментов', 'вызовов инструментов'] as const;

describe('lib/i18n/pluralRu (UXRD 10.2)', () => {
  it.each([
    { count: 1, expected: 'вызов инструмента' },
    { count: 2, expected: 'вызова инструментов' },
    { count: 5, expected: 'вызовов инструментов' },
    { count: 11, expected: 'вызовов инструментов' },
    { count: 21, expected: 'вызов инструмента' },
    { count: 22, expected: 'вызова инструментов' },
    { count: 25, expected: 'вызовов инструментов' },
  ])('$count → «$expected»', ({ count, expected }) => {
    expect(pluralRu(count, TOOL_CALL_FORMS)).toBe(expected);
  });
});
