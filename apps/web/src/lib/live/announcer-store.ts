import type { MessageKeys, NestedKeyOf, TranslationValues } from 'next-intl';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { Messages } from '@/i18n/catalog';

/** A full catalog key («announce.copied», «account.language.announced»). */
export type AnnouncementKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

/** A built-in tool's name as a value: `Announcer` shows its title from the `tools` catalogue (UXRD MC-9). */
export type BuiltinToolValue = { builtinTool: string };

export type AnnouncementValues = Record<
  string,
  TranslationValues[string] | BuiltinToolValue
>;

/** A phrase as data: `Announcer` translates it when it shows it, so it follows the interface language (KD-5). */
export type Announcement = {
  key: AnnouncementKey;
  values?: AnnouncementValues;
};

export type AnnouncerState = {
  /** The latest phrase for the shell's only polite live region; null before the first `announce`. */
  message: Announcement | null;
  /** Grows with every `announce`, so a repeated phrase still changes the region and is spoken again. */
  seq: number;
  announce: (key: AnnouncementKey, values?: AnnouncementValues) => void;
};

export type AnnouncerStore = StoreApi<AnnouncerState>;

export function createAnnouncerStore(): AnnouncerStore {
  return createStore<AnnouncerState>()((set) => ({
    message: null,
    seq: 0,
    announce: (key, values) =>
      set((state) => ({ message: { key, values }, seq: state.seq + 1 })),
  }));
}
