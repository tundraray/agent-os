const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
// The closing line may carry the prefixes of an enclosing blockquote or list item.
const CLOSING_FENCE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Whether the source of a fenced code block — the text under the node's position — ends with its closing fence
 * line (design-inline-vis.md, KD-2). The fence closes with a line of at least as many of the same characters.
 */
export function isClosedFence(source: string): boolean {
  const lines = source.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length < 2) return false;
  const opening = OPENING_FENCE.exec(lines[0] ?? '')?.[1];
  const closing = CLOSING_FENCE.exec(lines[lines.length - 1] ?? '')?.[1];
  if (opening === undefined || closing === undefined) return false;
  return closing[0] === opening[0] && closing.length >= opening.length;
}
