import { tokensOfBytes, utf8Bytes } from '../model/token-estimate';

/**
 * Large tool results (tool-result-reading plan, R-1…R-3): the wrapper the model gets instead of a long
 * MCP answer, and the pages and searches over the stored text. Pure functions; lengths are JavaScript
 * string characters (UTF-16 units), and no cut ever splits a surrogate pair.
 */

/** A line of a stored text ends at its line break or at this many characters, whichever comes first. */
const LINE_MAX_CHARS = 2_000;

/** A search shows at most this many matching lines. */
const SEARCH_MAX_MATCHES = 100;

/** The answer to a stored result that is not there or belongs to another session or owner. */
export const RESULT_NOT_FOUND = 'result not found';

/** A page of a stored text, or the line count when `offset` is past its last line. */
export type StoredPage =
  | {
      readonly kind: 'page';
      readonly text: string;
      readonly lastLine: number;
      readonly totalLines: number;
    }
  | { readonly kind: 'past_end'; readonly total: number };

/** The matching lines of a stored text with their header, or none. */
export type StoredSearch =
  | {
      readonly kind: 'found';
      readonly text: string;
      readonly total: number;
      readonly shown: number;
    }
  | { readonly kind: 'none' };

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `end` moved back by one when the character before it is the first half of a surrogate pair. */
function safeEnd(text: string, end: number): number {
  return end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1))
    ? end - 1
    : end;
}

/**
 * The first `previewChars` characters; when their last line break is past half of them, the preview
 * ends before it, so it does not stop in the middle of a line.
 */
export function previewOf(text: string, previewChars: number): string {
  if (text.length <= previewChars) return text;
  const head = text.slice(0, safeEnd(text, previewChars));
  const lastBreak = head.lastIndexOf('\n');
  return lastBreak > previewChars / 2 ? head.slice(0, lastBreak) : head;
}

/** The start of every wrapper: the text that tells a stored result's wrapper from a plain result. */
export const STORED_RESULT_MARK = '[stored result]';

/** What the model gets instead of a stored MCP result (R-1, R-3); the wording lives in the plan's Notes. */
export function wrapperText(input: {
  readonly callId: string;
  readonly text: string;
  readonly previewChars: number;
}): string {
  const { callId, text } = input;
  const preview = previewOf(text, input.previewChars);
  return [
    `${STORED_RESULT_MARK} Output too large: ${text.length} characters. The full output is stored under callId "${callId}".`,
    `Preview (first ${preview.length} characters):`,
    preview,
    '[end of preview]',
    `Read the rest with read_tool_result (callId "${callId}", offset = first line, from 1) or search it with search_tool_result (callId, pattern); in run_code: readResult("${callId}").`,
    'This is an MCP result: for a summary or an analysis, read the whole content in sequential parts; if you did not, say which part you read.',
  ].join('\n');
}

/** A tool error cut to `maxChars` with a note of how many characters were cut. */
export function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const end = safeEnd(text, maxChars);
  return `${text.slice(0, end)}\nresult cut by ${text.length - end} characters`;
}

/** The lines of a text: up to and including a line break, or `LINE_MAX_CHARS`; joined they are the text. */
export function linesOf(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const lineBreak = text.indexOf('\n', start);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak + 1;
    const end =
      lineEnd - start > LINE_MAX_CHARS
        ? safeEnd(text, start + LINE_MAX_CHARS)
        : lineEnd;
    lines.push(text.slice(start, end));
    start = end;
  }
  return lines;
}

/**
 * The page of lines from `offset` (1 = first): lines are added while `limit` lasts and the body stays
 * within `maxTokens`, at least one. The text is a banner line, a line break and the body — an exact
 * substring of `text`, so consecutive pages join into it.
 */
export function pageOf(
  text: string,
  request: {
    readonly offset: number;
    readonly limit?: number;
    readonly maxTokens: number;
  },
): StoredPage {
  const lines = linesOf(text);
  const total = lines.length;
  if (request.offset > total) return { kind: 'past_end', total };
  const maxLines = request.limit ?? total;
  let body = '';
  let bytes = 0;
  let count = 0;
  for (const line of lines.slice(request.offset - 1)) {
    if (count === maxLines) break;
    const nextBytes = bytes + utf8Bytes(line);
    if (count > 0 && tokensOfBytes(nextBytes) > request.maxTokens) break;
    body += line;
    bytes = nextBytes;
    count += 1;
  }
  const lastLine = request.offset + count - 1;
  const banner =
    lastLine < total
      ? `[partial view: lines ${request.offset}-${lastLine} of ${total}; next page at offset ${lastLine + 1}. Do not answer from this page alone.]`
      : `[lines ${request.offset}-${total} of ${total}: end of the stored result.]`;
  return {
    kind: 'page',
    text: `${banner}\n${body}`,
    lastLine,
    totalLines: total,
  };
}

/**
 * The lines that contain `pattern`, ignoring case, as `<number>: <line>`: at most `SEARCH_MAX_MATCHES`
 * and within `maxTokens`, at least one, under a header with the shown and total counts.
 */
export function searchOf(
  text: string,
  pattern: string,
  request: { readonly maxTokens: number },
): StoredSearch {
  const needle = pattern.toLowerCase();
  const matches: string[] = [];
  linesOf(text).forEach((line, index) => {
    if (line.toLowerCase().includes(needle))
      matches.push(`${index + 1}: ${line.replace(/\n$/, '')}`);
  });
  if (matches.length === 0) return { kind: 'none' };
  const shown: string[] = [];
  let bytes = 0;
  for (const match of matches.slice(0, SEARCH_MAX_MATCHES)) {
    const nextBytes = bytes + utf8Bytes(match) + 1;
    if (shown.length > 0 && tokensOfBytes(nextBytes) > request.maxTokens) break;
    shown.push(match);
    bytes = nextBytes;
  }
  const counts = `${shown.length} of ${matches.length} matching lines`;
  const header =
    shown.length < matches.length
      ? `[${counts}; refine the pattern to see the rest]`
      : `[${counts}]`;
  return {
    kind: 'found',
    text: [header, ...shown].join('\n'),
    total: matches.length,
    shown: shown.length,
  };
}

/** A copy of a JSON value with every string passed through `mask`; keys stay as they are. */
export function maskValue(
  value: unknown,
  mask: (text: string) => string,
): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value))
    return value.map((item: unknown) => maskValue(item, mask));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskValue(item, mask)]),
    );
  }
  return value;
}
