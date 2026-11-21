import { cutText, linesOf, pageOf, previewOf, searchOf, wrapperText } from './large-result';

// R-1…R-3 of the tool-result-reading plan; risk «a page splits a character or a very long line».
// Expected values are literals counted by hand.

/** A one-line JSON answer of 4 500 characters, as MCP servers send them. */
const ONE_LINE_JSON = `{${'x'.repeat(4_498)}}`;
/** 'a' ×1999, then an emoji (a surrogate pair) across the 2 000-character line cap. */
const PAIR_ON_LINE_CAP = `${'a'.repeat(1_999)}😀b`;
const FOUR_LINES = 'a\nb\nc\nd\n';

describe('a stored result is replaced by the wrapper and read in exact parts', () => {
  it.each([
    [
      'the cut goes back to a line break past half of the preview',
      'line one\nline two\nline three',
      20,
      'line one\nline two',
    ],
    ['a line break not past half keeps the whole preview', 'ab\ncdefghijklmnop', 10, 'ab\ncdefghi'],
    ['a line break exactly at half keeps the whole preview', 'abcde\nfghijk', 10, 'abcde\nfghi'],
    ['the preview never splits a surrogate pair', 'abcd😀efgh', 5, 'abcd'],
    ['a text that fits is its own preview', 'a\nb', 10, 'a\nb'],
  ])('preview: %s', (_case, text, previewChars, expected) => {
    expect(previewOf(text, previewChars)).toBe(expected);
  });

  it('a stored result is replaced by the wrapper with its size, callId, preview and how to read it', () => {
    const text = 'first line\nsecond line\nthird line';
    expect(wrapperText({ callId: 'call-7', text, previewChars: 25 })).toBe(
      [
        '[stored result] Output too large: 33 characters. The full output is stored under callId "call-7".',
        'Preview (first 22 characters):',
        'first line',
        'second line',
        '[end of preview]',
        'Read the rest with read_tool_result (callId "call-7", offset = first line, from 1) or search it with search_tool_result (callId, pattern); in run_code: readResult("call-7").',
        'This is an MCP result: for a summary or an analysis, read the whole content in sequential parts; if you did not, say which part you read.',
      ].join('\n'),
    );
  });

  it.each([
    ['a one-line JSON of 4 500 characters', ONE_LINE_JSON, [2_000, 2_000, 500]],
    ['a surrogate pair on the line cap stays in the next line', PAIR_ON_LINE_CAP, [1_999, 3]],
    ['a line ends after its line break, an empty line included', 'a\n\nb', [2, 1, 1]],
    ['an empty text has no lines', '', []],
  ] as const)('lines: %s', (_case, text, lengths) => {
    const lines = linesOf(text);
    expect(lines.map((line) => line.length)).toEqual(lengths);
    expect(lines.join('')).toBe(text);
  });

  it.each([
    [
      'the first page names the next offset',
      FOUR_LINES,
      { offset: 1, limit: 2, maxTokens: 100 },
      {
        kind: 'page',
        text: '[partial view: lines 1-2 of 4; next page at offset 3. Do not answer from this page alone.]\na\nb\n',
        lastLine: 2,
        totalLines: 4,
      },
    ],
    [
      'a middle page',
      FOUR_LINES,
      { offset: 2, limit: 2, maxTokens: 100 },
      {
        kind: 'page',
        text: '[partial view: lines 2-3 of 4; next page at offset 4. Do not answer from this page alone.]\nb\nc\n',
        lastLine: 3,
        totalLines: 4,
      },
    ],
    [
      'the last page says the result ends',
      FOUR_LINES,
      { offset: 3, maxTokens: 100 },
      {
        kind: 'page',
        text: '[lines 3-4 of 4: end of the stored result.]\nc\nd\n',
        lastLine: 4,
        totalLines: 4,
      },
    ],
    [
      'a one-line text is one last page',
      'only',
      { offset: 1, maxTokens: 100 },
      {
        kind: 'page',
        text: '[lines 1-1 of 1: end of the stored result.]\nonly',
        lastLine: 1,
        totalLines: 1,
      },
    ],
    [
      // 1 token = 4 bytes: lines 1-2 are 4 bytes, line 3 would make 6
      'the token limit shortens the page',
      FOUR_LINES,
      { offset: 1, maxTokens: 1 },
      {
        kind: 'page',
        text: '[partial view: lines 1-2 of 4; next page at offset 3. Do not answer from this page alone.]\na\nb\n',
        lastLine: 2,
        totalLines: 4,
      },
    ],
    [
      'one line over the token limit is still a page',
      'abcdefghij\nk\n',
      { offset: 1, maxTokens: 1 },
      {
        kind: 'page',
        text: '[partial view: lines 1-1 of 2; next page at offset 2. Do not answer from this page alone.]\nabcdefghij\n',
        lastLine: 1,
        totalLines: 2,
      },
    ],
    [
      'an offset past the last line',
      FOUR_LINES,
      { offset: 5, maxTokens: 100 },
      { kind: 'past_end', total: 4 },
    ],
  ] as const)('page: %s', (_case, text, request, expected) => {
    expect(pageOf(text, request)).toEqual(expected);
  });

  it('consecutive pages from the banner offsets join into exactly the stored text', () => {
    const text = `head\n${ONE_LINE_JSON}\n${PAIR_ON_LINE_CAP}\nжжж\ntail`;
    let joined = '';
    let offset = 1;
    for (;;) {
      const page = pageOf(text, { offset, maxTokens: 600 });
      if (page.kind !== 'page') throw new Error(`offset ${offset} is past the end`);
      joined += page.text.slice(page.text.indexOf('\n') + 1);
      if (page.lastLine === page.totalLines) break;
      offset = page.lastLine + 1;
    }
    expect(joined).toBe(text);
  });

  const LOG = 'Billing ok\nauth failed\nBILLING failed\nbilling retry\n';
  it.each([
    [
      'case-insensitive matches with their line numbers',
      'billing',
      100,
      {
        kind: 'found',
        text: '[3 of 3 matching lines]\n1: Billing ok\n3: BILLING failed\n4: billing retry',
        total: 3,
        shown: 3,
      },
    ],
    [
      // 8 tokens = 32 bytes: «1: Billing ok» and «3: BILLING failed» with their line breaks are 32
      'the token limit cuts the matches and asks to refine the pattern',
      'billing',
      8,
      {
        kind: 'found',
        text: '[2 of 3 matching lines; refine the pattern to see the rest]\n1: Billing ok\n3: BILLING failed',
        total: 3,
        shown: 2,
      },
    ],
    ['no matching line', 'missing', 100, { kind: 'none' }],
  ] as const)('search: %s', (_case, pattern, maxTokens, expected) => {
    expect(searchOf(LOG, pattern, { maxTokens })).toEqual(expected);
  });

  it('search shows at most 100 matching lines', () => {
    const found = searchOf('x\n'.repeat(150), 'X', { maxTokens: 100_000 });
    expect(found.kind === 'found' && found.text.split('\n')[0]).toBe(
      '[100 of 150 matching lines; refine the pattern to see the rest]',
    );
    expect(found).toMatchObject({ total: 150, shown: 100 });
  });

  it.each([
    [
      'a text over the limit is cut with the number of cut characters',
      'abcdefghij',
      4,
      'abcd\nresult cut by 6 characters',
    ],
    ['the cut never splits a surrogate pair', 'abc😀de', 4, 'abc\nresult cut by 4 characters'],
    ['a text within the limit stays whole', 'abcd', 4, 'abcd'],
  ])('error cut: %s', (_case, text, maxChars, expected) => {
    expect(cutText(text, maxChars)).toBe(expected);
  });
});
