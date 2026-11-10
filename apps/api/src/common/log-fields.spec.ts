import { withFields } from './log-fields.js';

// A log line of the package loggers: `key=value` pairs in the order given; a value taken from a request cannot forge a
// field or a line.
describe('withFields', () => {
  it.each([
    ['no fields', undefined, 'msg'],
    ['only undefined fields', { a: undefined }, 'msg'],
    [
      'identifiers, counts and outcome classes as given',
      { threadId: 't-1', count: 2, outcome: 'ok', flag: true },
      'msg threadId=t-1 count=2 outcome=ok flag=true',
    ],
    [
      'a value with whitespace or a control character as a JSON literal',
      {
        launchKey: 'k-1 threadId=other',
        threadId: 'a\nb',
        plain: 'c\u001bd',
      },
      'msg launchKey="k-1 threadId=other" threadId="a\\nb" plain="c\\u001bd"',
    ],
  ])('%s', (_case, fields, expected) => {
    expect(withFields('msg', fields)).toBe(expected);
  });
});
