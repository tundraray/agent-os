import { describe, expect, it } from 'vitest';

import { isClosedFence } from './fence';

// AC-09.3, AC-11.1: an open or cut-off fragment never runs as a page (design-inline-vis.md, KD-2).
describe('isClosedFence', () => {
  it.each<[string, string, boolean]>([
    ['open', '```inline-vis\n<svg></svg>\n', false],
    [
      'open, the closing line half written',
      '```inline-vis\n<svg></svg>\n``',
      false,
    ],
    ['closed', '```inline-vis Errors by day\n<svg></svg>\n```', true],
    [
      'closed by four backticks around three',
      '````inline-vis\n<pre>```</pre>\n````',
      true,
    ],
    [
      'four backticks not closed by three',
      '````inline-vis\n<p></p>\n```',
      false,
    ],
    ['empty and closed', '```inline-vis\n```', true],
    ['only the opening line', '```inline-vis', false],
  ])('%s', (_case, source, closed) => {
    expect(isClosedFence(source)).toBe(closed);
  });
});
