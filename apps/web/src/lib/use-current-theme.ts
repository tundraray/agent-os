'use client';

import { useSyncExternalStore } from 'react';
import type { ThemeId } from '@agent-os/contracts';
import { DEFAULT_THEME, THEME_ATTRIBUTE, readTheme } from './theme';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

/**
 * The current theme, following the attribute on `<html>`. The server does not know the cookie, so a page drawn
 * on the server shows the default until hydration (design-engine.md, Risks). It lives apart from `theme.ts`
 * because the server root layout imports that module, and a React hook import is not allowed there.
 */
export const useCurrentTheme = (): ThemeId =>
  useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);
