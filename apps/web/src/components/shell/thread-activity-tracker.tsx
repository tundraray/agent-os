'use client';

import { useEffect, useRef } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { useShellStatus } from './shell-actions';

/**
 * Lifts a thread to the top of «Сегодня» the moment a reply starts (D-11): on the `isRunning` edge
 * false → true of any list item it records `Date.now()` as the item's local activity time. Renders nothing.
 */
export function ThreadActivityTracker() {
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const bumpActivity = useShellStatus((s) => s.bumpActivity);
  const wasRunning = useRef(new Map<string, boolean>());

  useEffect(() => {
    const previous = wasRunning.current;
    const next = new Map<string, boolean>();
    for (const item of threadItems) {
      if (item.isRunning && previous.get(item.id) !== true) bumpActivity(item.id, Date.now());
      next.set(item.id, item.isRunning);
    }
    wasRunning.current = next;
  }, [threadItems, bumpActivity]);

  return null;
}
