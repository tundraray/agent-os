import { THEME_COOKIE, ThemeIdSchema, type ThemeId } from '@agent-os/contracts';
import { logger } from '@/lib/logger';

/** The built-in colour themes in card order (design system, Themes); each has its block in `globals.css`. */
export const THEME_IDS = ThemeIdSchema.options;

/** The theme of a page without the attribute or with an unknown one: `globals.css` puts it on `:root`. */
export const DEFAULT_THEME: ThemeId = 'graphite';

/** The attribute on `<html>` that selects the theme block; the head script of the root layout sets it too. */
export const THEME_ATTRIBUTE = 'data-theme';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const isThemeId = (value: unknown): value is ThemeId =>
  THEME_IDS.some((id) => id === value);

/** The theme on `<html>`; an attribute outside the list reads as the default, as the CSS draws it. */
export function readTheme(): ThemeId {
  const value = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  return isThemeId(value) ? value : DEFAULT_THEME;
}

/**
 * Applies the theme to the whole page in the same frame and keeps it in the cookie (design-engine.md, KD-2).
 * Colour transitions are off for the frame of the change, as next-themes does for the mode: otherwise
 * `transition-colors` stretches the repaint over 150 ms (foundations, Motion).
 */
export function chooseTheme(id: ThemeId): void {
  const previous = readTheme();
  const noTransitions = document.createElement('style');
  noTransitions.append('*,*::before,*::after{transition:none!important}');
  document.head.append(noTransitions);
  document.documentElement.setAttribute(THEME_ATTRIBUTE, id);
  // Reading the computed style applies the new colours while transitions are still off.
  window.getComputedStyle(document.body).getPropertyValue('color');
  requestAnimationFrame(() => noTransitions.remove());
  document.cookie = `${THEME_COOKIE}=${id}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  logger.info('theme: chosen', { previous, theme: id });
}
