import type { DraftView } from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** What one editor page hands to the editor that mounts on it next. */
export type Handoff = {
  /** The address of the editor page the handoff goes to. */
  page: string;
  /** The conversation a draft came from: the editor offers «Вернуться в беседу». */
  threadId?: string;
  /** The draft the form opens with; `null` — the record is already saved. */
  draft: DraftView | null;
  /** The record was just created on the previous address: the form opens «Сохранено». */
  created?: true;
};

export type DraftHandoffState = { handoff: Handoff | null };

/**
 * One handoff to an editor page (design-web.md, KD-6): a draft carried from a conversation, or a record just
 * created, whose new address mounts a new editor. It lives in the tab's memory only, so a reload drops it.
 */
export type DraftHandoff = StoreApi<DraftHandoffState> & {
  /** Replaces any earlier handoff. */
  put: (handoff: Handoff) => void;
  /** The handoff of `page`, once. A handoff to another page is dropped too: that page was left. */
  take: (page: string) => Handoff | null;
};

export function createDraftHandoff(): DraftHandoff {
  const store = createStore<DraftHandoffState>()(() => ({ handoff: null }));

  return Object.assign(store, {
    put: (handoff: Handoff): void => store.setState({ handoff }),
    take: (page: string): Handoff | null => {
      const { handoff } = store.getState();
      if (handoff === null) return null;
      store.setState({ handoff: null });
      return handoff.page === page ? handoff : null;
    },
  });
}
