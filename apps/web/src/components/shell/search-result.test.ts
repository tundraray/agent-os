import { describe, expect, it } from 'vitest';
import { titleAroundMark } from './search-result';

// A title match whose found word lies past the row's one-line truncation showed no mark at all.
describe('titleAroundMark', () => {
  it.each([
    {
      name: 'keeps a title found near its start',
      text: 'Timeout of thirty',
      marks: [{ start: 11, end: 17 }],
      expected: { text: 'Timeout of thirty', marks: [{ start: 11, end: 17 }] },
    },
    {
      name: 'starts from the word boundary before a far mark',
      text: 'Timeout of thirty seconds in payment-service',
      marks: [{ start: 29, end: 36 }],
      expected: {
        text: '…seconds in payment-service',
        marks: [{ start: 12, end: 19 }],
      },
    },
    {
      name: 'leaves out a long word that would hide the mark again',
      text: 'Supercalifragilisticexpialidocious kangaroo',
      marks: [{ start: 35, end: 43 }],
      expected: { text: '…kangaroo', marks: [{ start: 1, end: 9 }] },
    },
    {
      name: 'leaves out a hyphenated word whole instead of cutting it',
      text: 'Why payment-service needs timeout',
      marks: [{ start: 26, end: 33 }],
      expected: { text: '…needs timeout', marks: [{ start: 7, end: 14 }] },
    },
  ])('$name', ({ text, marks, expected }) => {
    expect(titleAroundMark({ text, marks })).toEqual(expected);
  });
});
