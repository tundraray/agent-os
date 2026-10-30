import { afterEach, describe, expect, it } from 'vitest';
import { isApplePlatform, isShortcutBlocked, matchShortcut, shortcutLabel } from './keyboard-shortcuts';

type Keys = Pick<KeyboardEventInit, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

const NEW_CHAT: Keys = { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true };
const TOGGLE_SIDEBAR: Keys = { code: 'KeyB', key: 'b', ctrlKey: true };

/** Dispatches a keydown on `target` and returns what `isShortcutBlocked` answers for it. */
function blockedOn(target: Element, keys: Keys): boolean {
  let blocked: boolean | undefined;
  target.addEventListener('keydown', (event) => {
    if (event instanceof KeyboardEvent) blocked = isShortcutBlocked(event);
  });
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...keys }));
  if (blocked === undefined) throw new Error('keydown did not reach the listener');
  return blocked;
}

function element(tag: string, attributes: Readonly<Record<string, string>> = {}): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

const composer = (): HTMLElement => document.body.appendChild(element('textarea'));

/** SB-08: the rename field sits inside the `[data-shortcuts-blocked]` wrapper. */
const renameField = (): HTMLElement => {
  const wrapper = document.body.appendChild(element('div', { 'data-shortcuts-blocked': '' }));
  return wrapper.appendChild(element('input', { 'aria-label': 'Название беседы' }));
};

/** The mobile drawer SB-13 as `ui/sidebar.tsx` renders it. */
const DRAWER = { role: 'dialog', 'aria-modal': 'true', 'data-slot': 'sidebar', 'data-mobile': 'true' };

const openLayer = (attributes: Readonly<Record<string, string>>): HTMLElement =>
  document.body.appendChild(element('div', attributes));

afterEach(() => {
  document.body.replaceChildren();
});

describe('isShortcutBlocked — where the global shortcuts do not fire (AC-22.1, UXRD 7.3)', () => {
  it.each([
    { where: 'composer, no layer open', setup: () => composer(), newChat: false, toggleSidebar: false },
    { where: 'SB-08 rename field', setup: () => renameField(), newChat: true, toggleSidebar: true },
    {
      where: 'open alertdialog (DLG-01)',
      setup: () => (openLayer({ role: 'alertdialog' }), composer()),
      newChat: true,
      toggleSidebar: true,
    },
    {
      where: 'open menu («⋯», SB-11)',
      setup: () => (openLayer({ role: 'menu' }), composer()),
      newChat: true,
      toggleSidebar: true,
    },
    {
      where: 'open modal dialog',
      setup: () => (openLayer({ role: 'dialog', 'aria-modal': 'true' }), composer()),
      newChat: true,
      toggleSidebar: true,
    },
    {
      where: 'open non-modal dialog',
      setup: () => (openLayer({ role: 'dialog' }), composer()),
      newChat: false,
      toggleSidebar: false,
    },
    {
      where: 'open drawer: only Ctrl/⌘+B passes, to close it',
      setup: () => openLayer(DRAWER).appendChild(element('a', { href: '/' })),
      newChat: true,
      toggleSidebar: false,
    },
    {
      where: 'open drawer with a menu open in it',
      setup: () => (openLayer({ role: 'menu' }), openLayer(DRAWER).appendChild(element('a', { href: '/' }))),
      newChat: true,
      toggleSidebar: true,
    },
    {
      where: 'rename field inside the open drawer',
      setup: () => {
        const wrapper = openLayer(DRAWER).appendChild(element('div', { 'data-shortcuts-blocked': '' }));
        return wrapper.appendChild(element('input'));
      },
      newChat: true,
      toggleSidebar: true,
    },
  ])('$where → Ctrl+Shift+O blocked: $newChat, Ctrl+B blocked: $toggleSidebar', ({ setup, newChat, toggleSidebar }) => {
    const target = setup();

    expect(blockedOn(target, NEW_CHAT)).toBe(newChat);
    expect(blockedOn(target, TOGGLE_SIDEBAR)).toBe(toggleSidebar);
  });
});

describe('matchShortcut — only the two listed combinations, by physical key', () => {
  it.each([
    { keys: NEW_CHAT, expected: 'new-chat' },
    { keys: { code: 'KeyO', key: 'O', metaKey: true, shiftKey: true }, expected: 'new-chat' },
    { keys: { code: 'KeyO', key: 'Щ', ctrlKey: true, shiftKey: true }, expected: 'new-chat' },
    { keys: { code: 'KeyO', key: 'o', ctrlKey: true }, expected: null },
    { keys: { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true, altKey: true }, expected: null },
    { keys: TOGGLE_SIDEBAR, expected: 'toggle-sidebar' },
    { keys: { code: 'KeyB', key: 'b', metaKey: true }, expected: 'toggle-sidebar' },
    { keys: { code: 'KeyB', key: 'и', ctrlKey: true }, expected: 'toggle-sidebar' },
    { keys: { code: 'KeyB', key: 'B', ctrlKey: true, shiftKey: true }, expected: null },
    { keys: { code: 'KeyB', key: 'b' }, expected: null },
  ] satisfies ReadonlyArray<{ keys: Keys; expected: string | null }>)(
    '$keys → $expected',
    ({ keys, expected }) => {
      expect(matchShortcut(new KeyboardEvent('keydown', keys))).toBe(expected);
    },
  );
});

describe('platform symbol in hints (UXRD 7.3: ⌘ on macOS, Ctrl elsewhere)', () => {
  it.each([
    { source: { platform: 'MacIntel' }, apple: true },
    { source: { platform: 'iPhone' }, apple: true },
    { source: { platform: '', userAgentData: { platform: 'macOS' } }, apple: true },
    { source: { platform: 'Win32' }, apple: false },
    { source: { platform: 'MacIntel', userAgentData: { platform: 'Windows' } }, apple: false },
    { source: { platform: 'Linux x86_64', userAgentData: {} }, apple: false },
  ])('$source → apple: $apple', ({ source, apple }) => {
    expect(isApplePlatform(source)).toBe(apple);
  });

  it.each([
    { shortcut: 'new-chat', apple: false, label: 'Ctrl+Shift+O' },
    { shortcut: 'new-chat', apple: true, label: '⌘+Shift+O' },
    { shortcut: 'toggle-sidebar', apple: false, label: 'Ctrl+B' },
    { shortcut: 'toggle-sidebar', apple: true, label: '⌘+B' },
  ] as const)('$shortcut, apple: $apple → «$label»', ({ shortcut, apple, label }) => {
    expect(shortcutLabel(shortcut, apple)).toBe(label);
  });
});
