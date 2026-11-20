import { useEffect } from 'react';
import { useStore } from 'zustand';
import { useShellServices } from '@/components/shell/shell-actions';

/** Marks the spare history entry pushed while unsaved changes are held. */
const GUARD_KEY = '__leaveGuard';

const historyState = (): Record<string, unknown> => {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null ? { ...state } : {};
};

const isGuardCurrent = (): boolean => GUARD_KEY in historyState();

/** A spare entry with the same address and App Router's own state: «Назад» pops it instead of leaving. */
const pushGuard = (): void => {
  window.history.pushState({ ...historyState(), [GUARD_KEY]: true }, '', window.location.href);
};

/** The next `popstate` is ours (the spare entry dropped): App Router must not see it. */
const swallowNextPopState = (): void => {
  window.addEventListener('popstate', (event) => event.stopImmediatePropagation(), { capture: true, once: true });
};

/**
 * KD-4 for what no link or button sees: closing the tab and the browser's «Назад». While `leaveGuard` holds
 * unsaved changes, `beforeunload` makes the browser ask its own question, and a spare history entry turns
 * «Назад» into the MC-11 question: «Остаться» puts the spare entry back, «Уйти без сохранения» goes one more
 * step back to the previous screen. Once the hold is released the spare entry is dropped again.
 *
 * App Router has no API for this: the capture listener on `window` runs before its own `popstate` listener and
 * stops it. Only a live browser proves that (L1 «Назад с изменениями»); if it fails, the «Назад» part leaves
 * this hook and «Назад» goes without a question, while links, «Новый чат» and the tab keep asking.
 */
export function useLeaveGuardHistory(): void {
  const { leaveGuard } = useShellServices();
  const holding = useStore(leaveGuard, (state) => state.held !== null);

  useEffect(() => {
    if (!holding) return;

    const onBeforeUnload = (event: BeforeUnloadEvent): void => event.preventDefault();

    const onPopState = (event: PopStateEvent): void => {
      // Released (left through MC-11 or saved): the step back is a real navigation for App Router.
      if (leaveGuard.getState().held === null) return;
      event.stopImmediatePropagation();
      void leaveGuard.confirmLeave().then((leave) => {
        if (leave) window.history.back();
        else pushGuard();
      });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('popstate', onPopState, { capture: true });
    pushGuard();

    // Still on the spare entry and nothing held again: step off it, out of App Router's sight.
    const dropGuard = (): void => {
      if (leaveGuard.getState().held !== null || !isGuardCurrent()) return;
      swallowNextPopState();
      window.history.back();
    };

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('popstate', onPopState, { capture: true });
      // A release is often followed at once by a navigation (a link, «Новый чат», delete): the drop waits a task,
      // and a screen App Router has pushed in the meantime keeps the spare entry rather than racing it.
      window.setTimeout(dropGuard, 0);
    };
  }, [holding, leaveGuard]);
}
