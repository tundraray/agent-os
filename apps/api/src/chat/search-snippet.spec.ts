import { describe, expect, it } from 'vitest';
import { snippetOf } from './search-snippet';

/** `[` and `]` stand for the marks of `ts_headline`. */
const headline = (text: string): string =>
  text.replaceAll('[', '\u0001').replaceAll(']', '\u0002');

const marked = ({ text, marks }: ReturnType<typeof snippetOf>): string[] =>
  marks.map(({ start, end }) => text.slice(start, end));

// Conversation-search KD-6 and search-result.md «Фрагмент»: the API returns a bounded fragment around the found word, its
// marks on the found words, «…» exactly where the text goes on. Catches a huge token (base64, padding) returned whole,
// a mark shifted off its word by the cut or the «…», and a «…» missing where the cut dropped text.
describe('snippetOf', () => {
  const padding = 'x'.repeat(59_000);
  it.each([
    {
      name: 'a short fragment stays whole, «…» only from the flags',
      row: {
        headline: headline('Отчёты по\nвыручке [квартал]'),
        before: true,
        after: false,
      },
      text: '…Отчёты по выручке квартал',
      words: ['квартал'],
    },
    {
      name: 'a huge token after the word is cut, «…» at the end',
      row: {
        headline: headline(
          `"service":"[provider]-[adapter]","message":"${padding}"`,
        ),
        before: false,
        after: false,
      },
      text: `"service":"provider-adapter","message":"${'x'.repeat(160 - 40)}…`,
      words: ['provider', 'adapter'],
    },
    {
      name: 'a huge token before the word is cut, the window ends with the text',
      row: {
        headline: headline(`${padding} timeout [payment]-service`),
        before: false,
        after: false,
      },
      text: '…timeout payment-service',
      words: ['payment'],
    },
    {
      // The defect seen in the sidebar: a short text came back whole and the two-line clamp hid the word.
      name: 'a short text returned whole starts a few words before a far word',
      row: {
        headline: headline(
          'Ответь одним коротким предложением: зачем сервису платежей нужен таймаут в 30 [секунд] и что будет без него',
        ),
        before: false,
        after: false,
      },
      text: '…нужен таймаут в 30 секунд и что будет без него',
      words: ['секунд'],
    },
    {
      name: 'a long text is cut at word boundaries on both sides, no space before «…»',
      row: {
        headline: headline(
          `${'слово '.repeat(30)}[секунд] и ещё ${'хвост '.repeat(40)}`,
        ),
        before: false,
        after: false,
      },
      text: `…слово слово слово секунд и ещё ${Array(21).fill('хвост').join(' ')}…`,
      words: ['секунд'],
    },
    {
      name: 'a fragment ending in white space has no space before «…»',
      row: { headline: headline('в [понятную] '), before: false, after: true },
      text: 'в понятную…',
      words: ['понятную'],
    },
    {
      // The defect seen in the sidebar: «…передам его вам…» where only the closing punctuation was cut.
      name: 'a cut dropping only punctuation gets no «…» at either edge',
      row: {
        headline: headline(
          `${'.'.repeat(25)} [слово] ${'хвост '.repeat(25)}— !!!`,
        ),
        before: false,
        after: false,
      },
      text: `слово ${'хвост '.repeat(25)}—`,
      words: ['слово'],
    },
    {
      name: 'a found word longer than the limit keeps its visible part marked',
      row: {
        headline: headline(`a [${'y'.repeat(300)}] b`),
        before: false,
        after: true,
      },
      text: `a ${'y'.repeat(158)}…`,
      words: ['y'.repeat(158)],
    },
  ])('$name', ({ row, text, words }) => {
    const snippet = snippetOf({
      headline: row.headline,
      continuesBefore: row.before,
      continuesAfter: row.after,
    });
    expect(snippet.text).toBe(text);
    expect(marked(snippet)).toEqual(words);
  });
});
