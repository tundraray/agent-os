import { useEffect, useSyncExternalStore } from 'react';
import { useShellActions } from '@/components/shell/shell-actions';
import { isApplePlatform, isShortcutBlocked, matchShortcut, shortcutLabel, type Shortcut } from '@/lib/keyboard-shortcuts';

/**
 * Ctrl/⌘+Shift+O → «Новый чат» from anywhere in the shell, guarded by `isShortcutBlocked`.
 * Ctrl/⌘+B is handled by `SidebarProvider` with the same guard.
 */
export function useGlobalShortcuts(): void {
  const { newChat } = useShellActions();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchShortcut(event) !== 'new-chat' || isShortcutBlocked(event)) return;
      event.preventDefault();
      newChat('shortcut');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newChat]);
}

const subscribeNever = (): (() => void) => () => {};
const getApplePlatform = (): boolean => isApplePlatform(navigator);
// The server does not know the platform; hints render «Ctrl» until hydration.
const getServerApplePlatform = (): boolean => false;

/** Tooltip hint for a shortcut with the platform's modifier symbol: «Ctrl+B» or «⌘+B». */
export function useShortcutLabel(shortcut: Shortcut): string {
  const apple = useSyncExternalStore(subscribeNever, getApplePlatform, getServerApplePlatform);
  return shortcutLabel(shortcut, apple);
}
