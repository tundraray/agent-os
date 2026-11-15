import { createStore, type StoreApi } from "zustand/vanilla";

export type AnnouncerState = {
  /** The latest phrase for the shell's only polite live region. */
  text: string;
  /** Grows with every `announce`, so a repeated phrase still changes the region and is spoken again. */
  seq: number;
  announce: (text: string) => void;
};

export type AnnouncerStore = StoreApi<AnnouncerState>;

export function createAnnouncerStore(): AnnouncerStore {
  return createStore<AnnouncerState>()((set) => ({
    text: "",
    seq: 0,
    announce: (text) => set((state) => ({ text, seq: state.seq + 1 })),
  }));
}
