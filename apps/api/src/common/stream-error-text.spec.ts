import { toStreamErrorText } from './stream-error-text.js';

// AC-14.5: the text the client sees for a stream error never carries the raw error message.
describe('toStreamErrorText', () => {
  it.each([
    ['an Error without statusCode', new Error('boom'), 'Agent error'],
    [
      'an Error with statusCode 529',
      Object.assign(new Error('overloaded'), { statusCode: 529 }),
      'Model provider error (529)',
    ],
    ['a non-Error value', 'x', 'Agent error'],
  ])('maps %s to %j', (_case, error, expected) => {
    expect(toStreamErrorText(error)).toBe(expected);
  });
});
