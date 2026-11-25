import type { ChipRecord } from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** The composer of a new conversation (`/`). */
export const NEW_THREAD_TARGET = 'new';

/** A conversation id, or `NEW_THREAD_TARGET`. */
export type SeedTarget = string;

/** The action chip «Создать и проверить агента» (create-and-test KD-1): its composer starts a test run. */
export const TEST_RUN_ACTION = 'test_run';
export type ActionChip = { action: typeof TEST_RUN_ACTION };

/** One chip per composer: a library record or the action. */
export type SeedChip = ChipRecord | ActionChip;

export type ComposerSeedState = {
  /** The chip of each target's composer: one chip per conversation (Invariant 4). */
  chips: ReadonlyMap<SeedTarget, SeedChip>;
  /** Template text not yet taken by the target's composer. */
  texts: ReadonlyMap<SeedTarget, string>;
};

/**
 * Carries a record chip and a template text to a conversation's composer (design-web.md, KD-5). The text
 * is taken once, when the composer appears; the chip stays until an accepted send, «✕» or a new seed.
 */
export type ComposerSeed = StoreApi<ComposerSeedState> & {
  /** The target's seed becomes exactly this: a new chip replaces the previous one, a seed without one drops it. */
  put: (target: SeedTarget, seed: Seed) => void;
  /** The template text of `target`, once; `null` when there is none or it was already taken. */
  takeText: (target: SeedTarget) => string | null;
  /**
   * Drops the target's chip: «✕», or the send of `record` was accepted or refused for it (DC-10) — then
   * only while the chip is still that one, since a chip put while the message was on its way is new.
   */
  clear: (target: SeedTarget, chip?: SeedChip) => void;
  /** The conversation `from` is gone: its chip and untaken text go to `to` (Flow 3). */
  move: (from: SeedTarget, to: SeedTarget) => void;
};

/** At most one of `record` and `action`; a seed without either drops the chip. */
type Seed = {
  record?: ChipRecord;
  action?: typeof TEST_RUN_ACTION;
  text?: string;
};

function without<V>(
  map: ReadonlyMap<SeedTarget, V>,
  key: SeedTarget,
): Map<SeedTarget, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function withEntry<V>(
  map: ReadonlyMap<SeedTarget, V>,
  key: SeedTarget,
  value: V | undefined,
): Map<SeedTarget, V> {
  const next = without(map, key);
  if (value !== undefined) next.set(key, value);
  return next;
}

export function createComposerSeed(): ComposerSeed {
  const store = createStore<ComposerSeedState>()(() => ({
    chips: new Map(),
    texts: new Map(),
  }));
  const { getState: get, setState: set } = store;

  return Object.assign(store, {
    put: (target: SeedTarget, { record, action, text }: Seed): void => {
      const { chips, texts } = get();
      set({
        chips: withEntry(
          chips,
          target,
          record ?? (action === undefined ? undefined : { action }),
        ),
        texts: withEntry(texts, target, text),
      });
    },
    takeText: (target: SeedTarget): string | null => {
      const { texts } = get();
      const text = texts.get(target);
      if (text === undefined) return null;
      set({ texts: without(texts, target) });
      return text;
    },
    clear: (target: SeedTarget, chip?: SeedChip): void => {
      const { chips } = get();
      const current = chips.get(target);
      if (current === undefined || (chip !== undefined && current !== chip))
        return;
      set({ chips: without(chips, target) });
    },
    move: (from: SeedTarget, to: SeedTarget): void => {
      const { chips, texts } = get();
      set({
        chips: withEntry(
          without(chips, from),
          to,
          chips.get(from) ?? chips.get(to),
        ),
        texts: withEntry(
          without(texts, from),
          to,
          texts.get(from) ?? texts.get(to),
        ),
      });
    },
  });
}
