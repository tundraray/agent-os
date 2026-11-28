import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The panel's tabs; «tasks» shows the conversation's own task list and appears with its first task (deep-agents UXRD
 * DA-12, MC-9), «documents» — its notepad documents, with the first document (self-learning UXRD DC-02), «run» —
 * the course and outcome of a test run or a training in its own conversation, in place of the other two (KD-6),
 * «aside» — the side chat, a branch of the conversation beside its feed (improvements UXRD IM-06).
 */
export type SchemaTab = 'schema' | 'tasks' | 'documents' | 'run' | 'aside';

/** The branch on «В стороне» (improvements KD-1): the tab holds one and shows it only beside its own conversation. */
export type AsideChat = {
  branchId: string;
  /** The conversation the branch was asked from. */
  threadId: string;
  /** The answer the branch was cut after: its «Спросить в стороне» takes focus back when the panel closes. */
  throughSeq: number;
};

export type WorkspaceState = {
  /** The employee's intent: the panel beside the feed from 1024 px, the drawer below it. */
  open: boolean;
  tab: SchemaTab;
  /** The document open on «Документы»; null — the list. */
  document: number | null;
  /** The panel's heading takes focus once it renders: an open by a button, never an automatic one (UXRD Accessibility). */
  focusHeading: boolean;
  aside: AsideChat | null;
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
  /** Opens the panel on «В стороне» with this branch; a new one replaces the previous (FR-09). */
  openAside: (aside: AsideChat) => void;
};

/** The side chat while `threadId` is the conversation on screen; null beside any other one. */
export const asideOf = (
  state: WorkspaceState,
  threadId: string | null,
): AsideChat | null =>
  state.aside !== null && state.aside.threadId === threadId
    ? state.aside
    : null;

/** The panel is open on the side chat of `threadId`: an automatic open does not take it away (improvements KD-1). */
export const asideOnScreen = (
  state: WorkspaceState,
  threadId: string | null,
): boolean =>
  state.open && state.tab === 'aside' && asideOf(state, threadId) !== null;

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
    aside: null,
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
    // Focus goes to the branch's composer, not the heading (improvements UXRD Accessibility).
    openAside: (aside: AsideChat) =>
      store.setState({
        open: true,
        tab: 'aside',
        document: null,
        focusHeading: false,
        aside,
      }),
  });
}
