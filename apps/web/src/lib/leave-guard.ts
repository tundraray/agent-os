import { createStore, type StoreApi } from 'zustand/vanilla';

export type LeaveGuardState = {
  /** The name of the record with unsaved changes on screen; `null` — nothing is held. */
  held: string | null;
  /** The open MC-11 question, with the held name; the dialog shows it and answers. */
  question: { name: string } | null;
};

/**
 * Unsaved changes on screen (design-web.md, KD-4). A screen holds while it has changes; every
 * navigation asks `confirmLeave()` first. Nothing held → `held` is `null` and the answer needs no
 * question, so a caller that must stay synchronous checks `held` before awaiting.
 */
export type LeaveGuard = StoreApi<LeaveGuardState> & {
  hold: (name: string) => void;
  /** Nothing to protect any more; an open question is answered «leave». */
  release: () => void;
  /** Whether to leave: at once `true` while nothing is held, otherwise the employee's answer to MC-11. */
  confirmLeave: () => Promise<boolean>;
  /** The dialog's answer: «Остаться» → `false` and the hold stays; «Уйти без сохранения» → `true`, released. */
  answer: (leave: boolean) => void;
};

export function createLeaveGuard(): LeaveGuard {
  const store = createStore<LeaveGuardState>()(() => ({
    held: null,
    question: null,
  }));
  let pending: {
    promise: Promise<boolean>;
    resolve: (leave: boolean) => void;
  } | null = null;

  function settle(leave: boolean): void {
    const open = pending;
    pending = null;
    store.setState(leave ? { held: null, question: null } : { question: null });
    open?.resolve(leave);
  }

  return Object.assign(store, {
    hold: (name: string): void => store.setState({ held: name }),
    release: (): void => {
      if (pending !== null) settle(true);
      else store.setState({ held: null });
    },
    confirmLeave: (): Promise<boolean> => {
      const { held } = store.getState();
      if (held === null) return Promise.resolve(true);
      if (pending === null) {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        pending = { promise, resolve };
        store.setState({ question: { name: held } });
      }
      return pending.promise;
    },
    answer: (leave: boolean): void => {
      if (pending !== null) settle(leave);
    },
  });
}
