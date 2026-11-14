import { logger } from '@/lib/logger';

/** Where focus lands after a shell transition (UXRD 7.4). */
export type FocusTarget = 'composer' | 'page-title';

/** Frames to wait for the target of the new view to render before giving up (about half a second). */
const MAX_FRAMES = 30;

/** A fine pointer (mouse, trackpad) gets the composer focused; a coarse one must not raise the on-screen keyboard. */
export const isFinePointer = (): boolean => window.matchMedia('(pointer: fine)').matches;

/**
 * Focuses after the next paint so the target of the new view exists.
 * 'composer' → [data-shell-focus="composer"] (ComposerPrimitive.Input), 'page-title' → [data-shell-focus="page-title"] (h1, tabIndex -1).
 */
export function focusShellTarget(target: FocusTarget): void {
  const attempt = (framesLeft: number): void => {
    const element = document.querySelector<HTMLElement>(`[data-shell-focus="${target}"]`);
    if (element !== null) {
      element.focus();
      return;
    }
    if (framesLeft === 0) {
      logger.warn('[web-shell] focus target is not rendered', { target });
      return;
    }
    requestAnimationFrame(() => attempt(framesLeft - 1));
  };
  requestAnimationFrame(() => attempt(MAX_FRAMES));
}

/** «Новый чат» and the cases that follow its pointer rule: the composer with a fine pointer, HD-03 otherwise. */
export const focusAfterNewChat = (): void => focusShellTarget(isFinePointer() ? 'composer' : 'page-title');
