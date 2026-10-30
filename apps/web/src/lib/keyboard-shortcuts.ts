/** The global shortcuts of the shell (UXRD 7.3, FR-22); no other combination is taken from the browser. */
export type Shortcut = 'new-chat' | 'toggle-sidebar';

/** Layers that suspend the global shortcuts while open. */
const MODAL_LAYER_SELECTOR = '[role="alertdialog"], [role="menu"], [role="dialog"][aria-modal="true"]';

/** The mobile drawer SB-13 (`ui/sidebar.tsx`): Ctrl/⌘+B still closes it. */
const DRAWER_SELECTOR = '[data-slot="sidebar"][data-mobile="true"]';

/** SB-08 and any other input that must keep every keystroke. */
const BLOCKED_AREA_SELECTOR = '[data-shortcuts-blocked]';

/**
 * Ctrl/⌘+Shift+O → new chat, Ctrl/⌘+B → sidebar. Matched by `event.code`, so the physical key works in any
 * keyboard layout (Cyrillic included); extra modifiers make it a different combination left to the browser.
 */
export function matchShortcut(event: KeyboardEvent): Shortcut | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.code === 'KeyO' && event.shiftKey) return 'new-chat';
  if (event.code === 'KeyB' && !event.shiftKey) return 'toggle-sidebar';
  return null;
}

/**
 * Whether a global shortcut must not fire for this keydown: typing inside `[data-shortcuts-blocked]`, or an
 * open alertdialog, menu or modal dialog. The open drawer does not block Ctrl/⌘+B, which closes it.
 */
export function isShortcutBlocked(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof Element && target.closest(BLOCKED_AREA_SELECTOR) !== null) return true;

  const drawerPasses = matchShortcut(event) === 'toggle-sidebar';
  return Array.from(document.querySelectorAll(MODAL_LAYER_SELECTOR)).some(
    (layer) => !(drawerPasses && layer.matches(DRAWER_SELECTOR)),
  );
}

/** What the platform check reads: `navigator.userAgentData.platform` where available, else `navigator.platform`. */
export type PlatformSource = { platform: string; userAgentData?: unknown };

function userAgentDataPlatform(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('platform' in data)) return undefined;
  return typeof data.platform === 'string' ? data.platform : undefined;
}

/** macOS and iOS show ⌘ in shortcut hints. */
export function isApplePlatform(source: PlatformSource): boolean {
  const platform = userAgentDataPlatform(source.userAgentData) ?? source.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const SHORTCUT_KEYS: Readonly<Record<Shortcut, string>> = {
  'new-chat': 'Shift+O',
  'toggle-sidebar': 'B',
};

/** Hint text for tooltips: «Ctrl+Shift+O», «⌘+B». */
export function shortcutLabel(shortcut: Shortcut, apple: boolean): string {
  return `${apple ? '⌘' : 'Ctrl'}+${SHORTCUT_KEYS[shortcut]}`;
}
