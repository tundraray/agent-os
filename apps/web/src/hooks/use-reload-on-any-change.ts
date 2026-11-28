import { useEffect, useLayoutEffect, useRef } from 'react';
import { useShellServices } from '@/components/shell/shell-actions';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';

/** Re-reads by live changes no more often than once a second, like the sidebar's counter. */
const REREAD_INTERVAL_MS = 1000;

/**
 * While a screen is open it re-reads on any conversation's state, row or deletion (live-feed design-web.md, KD-1)
 * and on every reconnect. The schedules and the tracker's list have no event of their own: what changes them —
 * a trigger, an agent's report — writes into a conversation, so this shows it without a reload.
 */
export function useReloadOnAnyChange(reload: () => void): void {
  const { live } = useShellServices();
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    // `reload` only starts reads; it never rejects, so the runner never hands a rejection on.
    const runner = createCoalescedRunner(
      async () => {
        reloadRef.current();
      },
      { minIntervalMs: REREAD_INTERVAL_MS },
    );
    const request = (): void => {
      void runner.request();
    };
    const unsubscribers = [
      live.onChange({ kinds: ['state', 'summary', 'deleted'] }, request),
      live.onReady(request),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      runner.cancel();
    };
  }, [live]);
}
