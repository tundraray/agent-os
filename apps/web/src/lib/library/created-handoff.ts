import { createStore, type StoreApi } from 'zustand/vanilla';

export type CreatedHandoffState = { page: string | null };

/**
 * The editor page of a record just created (design-web.md, KD-6): the create answers on the «new» address, and
 * the record's own address mounts a new editor, which opens «Сохранено». It lives in the tab's memory only, so a
 * reload drops it.
 */
export type CreatedHandoff = StoreApi<CreatedHandoffState> & {
  /** Replaces any earlier handoff. */
  put: (page: string) => void;
  /** Whether the handoff is for `page`, once. A handoff to another page is dropped too: that page was left. */
  take: (page: string) => boolean;
};

export function createCreatedHandoff(): CreatedHandoff {
  const store = createStore<CreatedHandoffState>()(() => ({ page: null }));

  return Object.assign(store, {
    put: (page: string): void => store.setState({ page }),
    take: (page: string): boolean => {
      const handed = store.getState().page;
      if (handed === null) return false;
      store.setState({ page: null });
      return handed === page;
    },
  });
}
