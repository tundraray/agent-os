import { safeHref } from '@/utils/href';

/** How a link from untrusted model markdown is rendered. */
export type LinkPolicy =
  | { kind: 'unsafe' } // no usable href: javascript:, data:, vbscript:, not a URL
  | { kind: 'fragment'; href: string } // #id inside the message (remark-gfm footnotes)
  | { kind: 'mail'; href: string } // mailto: goes to the mail client, the document stays
  | { kind: 'new-tab'; href: string }; // http(s) and same-origin paths keep background streams alive

export function linkPolicy(url: string | undefined): LinkPolicy {
  const href = safeHref(url);
  if (href === undefined) return { kind: 'unsafe' };
  if (href.startsWith('#')) return { kind: 'fragment', href };
  if (href.toLowerCase().startsWith('mailto:')) return { kind: 'mail', href };
  return { kind: 'new-tab', href };
}

/** Only absolute https images are fetched by the browser. */
export function isRenderableImageSrc(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  try {
    return new URL(src).protocol === 'https:';
  } catch {
    return false;
  }
}
