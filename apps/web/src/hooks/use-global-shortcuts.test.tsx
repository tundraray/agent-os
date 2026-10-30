import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalShortcuts } from './use-global-shortcuts';

const { newChat } = vi.hoisted(() => ({ newChat: vi.fn() }));

vi.mock('@/components/shell/shell-actions', () => ({
  useShellActions: () => ({ newChat }),
}));

afterEach(() => {
  document.body.replaceChildren();
});

describe('useGlobalShortcuts — Ctrl/⌘+Shift+O wiring (AC-22.1)', () => {
  it('opens a new chat and takes the key from the browser; inside SB-08 it does neither', () => {
    renderHook(() => useGlobalShortcuts());
    const composer = document.body.appendChild(document.createElement('textarea'));
    const renameWrapper = document.body.appendChild(document.createElement('div'));
    renameWrapper.setAttribute('data-shortcuts-blocked', '');
    const renameField = renameWrapper.appendChild(document.createElement('input'));
    const keys = { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true };

    const composerNotPrevented = fireEvent.keyDown(composer, keys);

    expect(newChat).toHaveBeenCalledExactlyOnceWith('shortcut');
    expect(composerNotPrevented).toBe(false);

    const renameNotPrevented = fireEvent.keyDown(renameField, keys);

    expect(newChat).toHaveBeenCalledTimes(1);
    expect(renameNotPrevented).toBe(true);
  });
});
