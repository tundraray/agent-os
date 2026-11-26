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
/**
 * At most this much text before the first found word, cut back to a word start: two or three words, so the
 * word starts on the first line of the row (some 30 characters at the narrowest sidebar) and the two-line
 * clamp never hides it. `ts_headline` itself keeps up to half its 35 words before the word, or the whole
 * text when it is short.
 */
const CONTEXT_BEFORE = 20;

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

const isSpace = (char: string): boolean => /\s/.test(char);

/**
 * Where the fragment starts: the first word start at most CONTEXT_BEFORE before the first found word; the
 * found word itself when no word starts there (one long token before it).
 */
function startOf(text: string, firstMark: number): number {
  if (firstMark <= CONTEXT_BEFORE) return 0;
  for (let at = firstMark - CONTEXT_BEFORE; at <= firstMark; at += 1) {
    if (isSpace(text.charAt(at - 1)) && !isSpace(text.charAt(at))) return at;
  }
  return firstMark;
}

/**
 * Where the fragment ends: at most SNIPPET_MAX_LENGTH after its start, cut back to a word end past the first
 * found word; a hard cut only inside one long token.
 */
function endOf(text: string, start: number, firstMarkEnd: number): number {
  const limit = start + SNIPPET_MAX_LENGTH;
  if (limit >= text.length) return text.length;
  for (let at = limit; at > firstMarkEnd; at -= 1) {
    if (isSpace(text.charAt(at))) return at;
  }
  return splitsPair(text, limit) ? limit - 1 : limit;
}

/** The window of the fragment around the first found word, without white space at its edges. */
function windowOf(
  text: string,
  firstMark: { start: number; end: number },
): [number, number] {
  let start = startOf(text, firstMark.start);
  let end = endOf(text, start, firstMark.end);
  while (start < end && isSpace(text.charAt(start))) start += 1;
  while (end > start && isSpace(text.charAt(end - 1))) end -= 1;
  return [start, end];
}

/**
 * The fragment of a match (contract `MarkedText`): from a few words before the first found word, at most
 * SNIPPET_MAX_LENGTH, cut at word boundaries, on one line, with «…» on an edge past which the text goes on.
 * A found word crossing a hard cut keeps its visible part.
 */
export function snippetOf(row: Headline): MarkedText {
  const { text, marks } = parseHeadline(row.headline ?? '');
  const [start, end] = windowOf(text, marks[0] ?? { start: 0, end: 0 });
  const before = row.continuesBefore || text.slice(0, start).trim() !== '';
  const after = row.continuesAfter || text.slice(end).trim() !== '';
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
