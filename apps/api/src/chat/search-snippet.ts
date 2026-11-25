import type { MarkedText } from '@agent-os/contracts';

/** The marks `ConversationSearchRepository` puts around a found word. */
const MARK_START = '\u0001';
const MARK_END = '\u0002';
const ELLIPSIS = '…';

/**
 * The longest fragment, without its «…»: two lines of the result row at the widest sidebar, with room to spare
 * (search-result.md, «Фрагмент» — at most two lines). One huge token of a result is cut to it.
 */
const SNIPPET_MAX_LENGTH = 160;
/** How much text before the first found word the fragment keeps when it has to be cut. */
const CONTEXT_BEFORE = 40;

/** A headline of `ts_headline` and whether its text goes on before or after it. */
export interface Headline {
  readonly headline: string | null;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

/** The text of a headline without its marks, and the ranges of the marked words in it. */
export function parseHeadline(headline: string): MarkedText {
  let text = '';
  let start: number | null = null;
  const marks: MarkedText['marks'] = [];
  for (const char of headline) {
    if (char === MARK_START) {
      start = text.length;
    } else if (char === MARK_END) {
      if (start !== null && text.length > start)
        marks.push({ start, end: text.length });
      start = null;
    } else {
      text += char;
    }
  }
  return { text, marks };
}

/** True when `index` falls between the halves of a surrogate pair. */
const splitsPair = (text: string, index: number): boolean =>
  index > 0 &&
  index < text.length &&
  /[\uDC00-\uDFFF]/.test(text.charAt(index)) &&
  /[\uD800-\uDBFF]/.test(text.charAt(index - 1));

/** The window of at most SNIPPET_MAX_LENGTH that starts a little before the first found word. */
function windowOf(text: string, firstMark: number): [number, number] {
  if (text.length <= SNIPPET_MAX_LENGTH) return [0, text.length];
  let start = Math.max(
    0,
    Math.min(firstMark - CONTEXT_BEFORE, text.length - SNIPPET_MAX_LENGTH),
  );
  let end = start + SNIPPET_MAX_LENGTH;
  if (splitsPair(text, start)) start += 1;
  if (splitsPair(text, end)) end -= 1;
  return [start, end];
}

/**
 * The fragment of a match (contract `MarkedText`): cut to SNIPPET_MAX_LENGTH around the first found word, on one
 * line, with «…» on an edge past which the text goes on. A found word crossing the cut keeps its visible part.
 */
export function snippetOf(row: Headline): MarkedText {
  const { text, marks } = parseHeadline(row.headline ?? '');
  const [start, end] = windowOf(text, marks[0]?.start ?? 0);
  const before = row.continuesBefore || start > 0;
  const after = row.continuesAfter || end < text.length;
  const prefix = before ? ELLIPSIS : '';
  const shift = prefix.length - start;
  return {
    text: `${prefix}${text.slice(start, end).replace(/[\r\n]/g, ' ')}${after ? ELLIPSIS : ''}`,
    marks: marks
      .filter((mark) => mark.end > start && mark.start < end)
      .map((mark) => ({
        start: Math.max(mark.start, start) + shift,
        end: Math.min(mark.end, end) + shift,
      })),
  };
}
