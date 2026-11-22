import { createStore, type StoreApi } from 'zustand/vanilla';

/** The panel's tabs; «tasks» shows the conversation's own task list and appears with its first task (deep-agents UXRD DA-12, MC-9). */
export type SchemaTab = 'schema' | 'tasks';

export type WorkspaceState = {
  /** The employee's intent: the panel beside the feed from 1024 px, the drawer below it. */
  open: boolean;
  tab: SchemaTab;
  /** The panel's heading takes focus once it renders: an open by a button, never an automatic one (UXRD Accessibility). */
  focusHeading: boolean;
};

export type WorkspaceStore = StoreApi<WorkspaceState> & {
  /** Opens the panel; `tab` switches it, `focusHeading` — an employee's button opened it. */
  show: (options: { tab?: SchemaTab; focusHeading: boolean }) => void;
  close: () => void;
  setTab: (tab: SchemaTab) => void;
  /** The heading took the focus `show` asked for. */
  headingFocused: () => void;
};

/**
 * The diagram panel's state for the whole shell (deep-agents design-agent-types.md, C3 web, first point): the
 * header button, «Показать схему» of a record card and the automatic open on a record change all open the same
 * panel. Memory of the tab only: a reload starts closed (chat-shell UXRD, AC-11.1).
 */
export function createWorkspaceStore(): WorkspaceStore {
  const store = createStore<WorkspaceState>()(() => ({ open: false, tab: 'schema', focusHeading: false }));
  return Object.assign(store, {
    show: ({ tab, focusHeading }: { tab?: SchemaTab; focusHeading: boolean }) =>
      store.setState((state) => ({ open: true, tab: tab ?? state.tab, focusHeading })),
    close: () => store.setState({ open: false, focusHeading: false }),
    setTab: (tab: SchemaTab) => store.setState({ tab }),
    headingFocused: () => store.setState({ focusHeading: false }),
  });
}
