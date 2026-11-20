'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { ChipRecord } from '@agent-os/contracts';
import { leaveThenGo, useShellServices } from '@/components/shell/shell-actions';
import { focusShellTarget } from '@/lib/focus';
import { NEW_THREAD_TARGET, type SeedTarget } from '@/lib/threads/composer-seed';
import { threadPath } from '@/lib/shell-route';

/** A screen's own navigation that respects unsaved changes (KD-4): the shell's `leaveThenGo` bound to its `leaveGuard`. */
export function useLeaveThenGo(): (go: () => void) => void {
  const { leaveGuard } = useShellServices();
  return useCallback((go: () => void) => leaveThenGo(leaveGuard, go), [leaveGuard]);
}

export type InChatSeed = {
  /** The record chip the composer shows until the message is sent or «✕». */
  record?: ChipRecord;
  /** A template text the composer takes once («Создать в чате», «Доработать в чате»). */
  text?: string;
};

/**
 * «Использовать в чате» and every other way into a conversation with a seed (design-web.md, KD-5): the chip
 * or template goes to `composerSeed` for the target — a conversation by id, a new one by default — then the
 * shell goes to that conversation and the focus to its message field. Nothing is sent: the run starts with
 * the employee's message.
 */
export function useInChat(): (seed: InChatSeed, target?: SeedTarget) => void {
  const { composerSeed } = useShellServices();
  const router = useRouter();
  const leaveThenGo = useLeaveThenGo();
  return useCallback(
    (seed: InChatSeed, target: SeedTarget = NEW_THREAD_TARGET) =>
      leaveThenGo(() => {
        composerSeed.put(target, seed);
        router.push(target === NEW_THREAD_TARGET ? '/' : threadPath(target));
        focusShellTarget('composer');
      }),
    [composerSeed, router, leaveThenGo],
  );
}
