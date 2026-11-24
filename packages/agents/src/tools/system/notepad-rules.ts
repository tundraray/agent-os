import { DOCUMENT_MAX_CHARS } from '@agent-os/contracts';

/** A change of a document's text: add to its end, or replace a fragment that occurs exactly once. */
export type DocumentEdit =
  | { readonly kind: 'append'; readonly text: string }
  | { readonly kind: 'replace'; readonly old: string; readonly new: string };

/**
 * The new text of a document after an edit, or the refusal that names why (design-notepad.md KD-2, KD-5): the
 * fragment occurs 0 or several times (non-overlapping), or the result is longer than the document limit.
 */
export function editDocument(
  current: string,
  edit: DocumentEdit,
):
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'refused'; readonly text: string } {
  let text: string;
  if (edit.kind === 'append') {
    text = current + edit.text;
  } else {
    const places = current.split(edit.old).length - 1;
    if (places !== 1)
      return {
        kind: 'refused',
        text: `The fragment occurs ${places} times in the document; give a fragment that occurs exactly once.`,
      };
    const at = current.indexOf(edit.old);
    text =
      current.slice(0, at) + edit.new + current.slice(at + edit.old.length);
  }
  if (text.length > DOCUMENT_MAX_CHARS)
    return {
      kind: 'refused',
      text: `The document would have ${text.length} characters, over the limit of ${DOCUMENT_MAX_CHARS}; it now has ${current.length}. Nothing was written.`,
    };
  return { kind: 'text', text };
}
