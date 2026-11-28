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

/** A phrase in the queue; `seq` grows with every `announce`, so a repeated phrase is a new one. */
export type QueuedAnnouncement = { seq: number; announcement: Announcement };

export type AnnouncerState = {
  /**
   * The latest phrases for the shell's only polite live region, oldest first: each is its own node there, so
   * phrases announced together are spoken in turn (agent-guidance UXRD, Accessibility); empty before the first
   * `announce`.
   */
  queue: readonly QueuedAnnouncement[];
  announce: (key: AnnouncementKey, values?: AnnouncementValues) => void;
};

export type AnnouncerStore = StoreApi<AnnouncerState>;

/** Phrases kept in the region; older nodes are already spoken and only grow the page. */
const QUEUE_LENGTH = 8;

export function createAnnouncerStore(): AnnouncerStore {
  let seq = 0;
  return createStore<AnnouncerState>()((set) => ({
    queue: [],
    announce: (key, values) => {
      seq += 1;
      const next = { seq, announcement: { key, values } };
      set((state) => ({
        queue: [...state.queue, next].slice(-QUEUE_LENGTH),
      }));
    },
  }));
}
