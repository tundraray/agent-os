import { logger } from '@/lib/logger';

/** Where focus lands after a shell transition (UXRD 7.4). */
export type FocusTarget = 'composer' | 'page-title';

/** Frames to wait for the target of the new view to render before giving up (about half a second). */
const MAX_FRAMES = 30;

/** Frames the focused target is watched (about five seconds): long enough for a route's server round trip. */
const SETTLE_FRAMES = 300;

/** A fine pointer (mouse, trackpad) gets the composer focused; a coarse one must not raise the on-screen keyboard. */
export const isFinePointer = (): boolean => window.matchMedia('(pointer: fine)').matches;

/**
 * Focuses after the next paint so the target of the new view exists.
 * 'composer' → [data-shell-focus="composer"] (ComposerPrimitive.Input), 'page-title' → [data-shell-focus="page-title"] (h1, tabIndex -1).
 */
export function focusShellTarget(target: FocusTarget): void {
  let settleFramesLeft = SETTLE_FRAMES;
  const search = (framesLeft: number): void => {
    const element = document.querySelector<HTMLElement>(`[data-shell-focus="${target}"]`);
    if (element !== null) {
      element.focus();
      requestAnimationFrame(() => watch(element));
      return;
    }
    if (framesLeft === 0) {
      logger.warn('[web-shell] focus target is not rendered', { target });
      return;
    }
    requestAnimationFrame(() => search(framesLeft - 1));
  };
  // A click starts the focus before the route changes, so the outgoing view's target (an agent page's
  // composer or h1) can take it first; when that view is replaced, focus falls to <body> and moves on to
  // the new view's target. Focus the user moved elsewhere ends the watch.
  const watch = (element: HTMLElement): void => {
    settleFramesLeft -= 1;
    if (settleFramesLeft === 0) return;
    if (!element.isConnected && document.activeElement === document.body) {
      search(MAX_FRAMES);
      return;
    }
    if (document.activeElement === element) requestAnimationFrame(() => watch(element));
  };
  requestAnimationFrame(() => search(MAX_FRAMES));
}

/** «Новый чат» and the cases that follow its pointer rule: the composer with a fine pointer, HD-03 otherwise. */
export const focusAfterNewChat = (): void => focusShellTarget(isFinePointer() ? 'composer' : 'page-title');
