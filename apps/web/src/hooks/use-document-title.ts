import { useEffect } from 'react';

export const APP_NAME = 'Agent OS';

/** The tab title of a page inside the app: its parts, outermost last, then the app's name. */
export const pageTitle = (...parts: string[]): string =>
  [...parts, APP_NAME].join(' — ');

/**
 * Sets the browser tab title and keeps it: Next puts the layout's own `<title>` into the head when its
 * metadata arrives, which on a direct load can be after this effect ran, so every change of the head that
 * leaves another title is undone. `undefined` leaves the title as it is.
 */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined) return;
    const apply = (): void => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [title]);
}
