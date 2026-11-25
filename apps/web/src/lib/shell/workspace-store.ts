import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The panel's tabs; «tasks» shows the conversation's own task list and appears with its first task (deep-agents UXRD
 * DA-12, MC-9), «documents» — its notepad documents, with the first document (self-learning UXRD DC-02), «run» —
 * the course and outcome of a test run or a training in its own conversation, in place of the other two (KD-6).
 */
export type SchemaTab = 'schema' | 'tasks' | 'documents' | 'run';

export type WorkspaceState = {
  /** The employee's intent: the panel beside the feed from 1024 px, the drawer below it. */
  open: boolean;
  tab: SchemaTab;
  /** The document open on «Документы»; null — the list. */
  document: number | null;
  /** The panel's heading takes focus once it renders: an open by a button, never an automatic one (UXRD Accessibility). */
  focusHeading: boolean;
};

type ShowOptions = {
  tab?: SchemaTab;
  document?: number;
  focusHeading: boolean;
};

export type WorkspaceStore = StoreApi<WorkspaceState> & {
  /** Opens the panel; `tab` switches it, `document` opens one on «Документы», `focusHeading` — an employee's button opened it. */
  show: (options: ShowOptions) => void;
  close: () => void;
  /** Switches the tab and goes back to the document list. */
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
  const store = createStore<WorkspaceState>()(() => ({
    open: false,
    tab: 'schema',
    document: null,
    focusHeading: false,
  }));
  return Object.assign(store, {
    show: ({ tab, document, focusHeading }: ShowOptions) =>
      store.setState((state) => ({
        open: true,
        tab: tab ?? state.tab,
        document: document ?? null,
        focusHeading,
      })),
    close: () => store.setState({ open: false, focusHeading: false }),
    setTab: (tab: SchemaTab) => store.setState({ tab, document: null }),
    headingFocused: () => store.setState({ focusHeading: false }),
  });
}
